import { SQL } from "bun";
import { createProductStore, productDatabaseFromNative } from "/app/server/src/product/store.ts";
import { projectOperations } from "/app/server/src/product/projects.ts";
import { readinessOperations } from "/app/server/src/product/readiness.ts";
import { createProductModule } from "/app/server/src/product/module.ts";
import { saveWorkflowSelection } from "/app/server/src/product/workflow-routing.ts";
import { archiveProject } from "/app/server/src/product/archive.ts";
import { dispatchPendingWorkflow } from "/app/server/src/product/workflow-engine.ts";
import { currentGuidance, recordGuidance } from "/app/server/src/product/feedback.ts";
import { createProductRoutes } from "/app/server/src/product/routes.ts";
import { readFile } from "node:fs/promises";

const client = new SQL({ hostname: "postgres", port: 5432, username: "postgres", password: "probe", database: "postgres" });
const database = productDatabaseFromNative({ $client: client });
const actor = { id: "owner", role: "admin" } as const;
const store = createProductStore(database);
const serviceModule = await createProductModule(database, "/fixture");
if (!serviceModule) throw Error("distinct business module was not loaded");
const serviceDefinition = JSON.parse(await readFile('/fixture/blueprint.json', 'utf8'));
const publishedService = await serviceModule.publish(actor, serviceDefinition);
if (publishedService.key !== 'service-operations') throw Error('distinct business publication failed');
const serviceProjects = projectOperations(serviceModule as any, async input => {
  const channel = 'channel-' + input.projectId;
  await database.unsafe('insert into channels(id) values($1)', [channel]);
  await database.unsafe('insert into channel_memberships(channel_id,user_id) values($1,$2)', [channel, actor.id]);
  await database.unsafe('insert into bp_conversations(project_id,native_channel_id,team_lead_assignment_id) values($1,$2,$3)', [input.projectId, channel, input.assignmentId]);
});
const serviceProject = await serviceProjects.create(actor, { name: 'service' }, 'service-project');
await database.unsafe("update bp_projects set state='Operational' where id=$1", [serviceProject.id]);
await database.unsafe("insert into bp_readiness(project_id,assignment_id,assignment_revision,input_digest,status,evidence) select project_id,id,revision,'fixture','Ready','{}'::jsonb from bp_assignments where project_id=$1", [serviceProject.id]);
const schema = JSON.parse(await readFile('/app/server/src/product/contract/blueprint.schema.json', 'utf8'));
const selection = { channelId: 'channel-' + serviceProject.id, request: 'Handle a service request', interpretation: { workflowId: 'service-request' } };
const firstSelection = await saveWorkflowSelection(serviceModule, actor, serviceProject.id, selection, 'route-once', schema);
const repeatedSelection = await saveWorkflowSelection(serviceModule, actor, serviceProject.id, selection, 'route-once', schema);
if (firstSelection.status !== 'saved' || repeatedSelection.status !== 'saved' || firstSelection.runId !== repeatedSelection.runId) throw Error('workflow routing was not idempotent');
let dispatchedIdentity: any;
const engine = Bun.serve({ port: 0, async fetch(request) { dispatchedIdentity = await request.json(); return Response.json({ workflowId: 'stable-workflow-id', existing: false }); } });
process.env.WORKFLOW_ENGINE_URL = 'http://127.0.0.1:' + engine.port;
process.env.WORKFLOW_ENGINE_TOKEN = 'x'.repeat(32);
if (!await dispatchPendingWorkflow(serviceModule)) throw Error('pending workflow was not dispatched');
if (dispatchedIdentity.run.projectId !== serviceProject.id || dispatchedIdentity.run.runId !== firstSelection.runId) throw Error('workflow dispatch lost its project binding');
if (await dispatchPendingWorkflow(serviceModule)) throw Error('the same workflow was dispatched twice');
engine.stop();
const [serviceAssignment] = await database.unsafe<{ id: string }>('select id from bp_assignments where project_id=$1 limit 1', [serviceProject.id]);
await database.unsafe('insert into intelligence_channel_mappings values ($1,$2,$3)', [selection.channelId, actor.id, 'native-thread']);
const nativeFeedback = await recordGuidance(serviceModule, actor, serviceProject.id, serviceAssignment.id,
  { guidance: 'Use native conversation feedback.', source: { conversationId: selection.channelId, messageId: 'native-message' } },
  'native-feedback', async (thread, user, message) => thread === 'native-thread' && user === actor.id && message === 'native-message');
if (!nativeFeedback.id) throw Error('native conversation feedback was not saved');
await database.unsafe("insert into group_messages values ($1,$2,$3,null,'completed')", ['feedback-1', selection.channelId, actor.id]);
const source = { conversationId: selection.channelId, messageId: 'feedback-1' };
const memory = await recordGuidance(serviceModule, actor, serviceProject.id, serviceAssignment.id, { guidance: 'Include reproduction steps.', source }, 'feedback-create');
const replayedMemory = await recordGuidance(serviceModule, actor, serviceProject.id, serviceAssignment.id, { guidance: 'Include reproduction steps.', source }, 'feedback-create');
if (memory.id !== replayedMemory.id) throw Error('feedback retry created another entry');
let changedRetryRejected = false;
try { await recordGuidance(serviceModule, actor, serviceProject.id, serviceAssignment.id, { guidance: 'Different feedback.', source }, 'feedback-create'); }
catch (error: any) { changedRetryRejected = error.code === 'idempotency_conflict'; }
if (!changedRetryRejected) throw Error('feedback key accepted a different payload');
await recordGuidance(serviceModule, actor, serviceProject.id, serviceAssignment.id, { guidance: 'Include reproduction steps for intermittent failures.', source, entryId: memory.id, expectedRevision: 1 }, 'feedback-correct');
const guidance = await currentGuidance(serviceModule, actor, serviceProject.id, serviceAssignment.id);
if (guidance.length !== 2 || !guidance.some(item => item.id === memory.id && item.revision === 2 && item.guidance.includes('intermittent'))) throw Error('feedback correction was not applied');
let conflictRejected = false;
try { await recordGuidance(serviceModule, actor, serviceProject.id, serviceAssignment.id, { guidance: 'Stale correction.', source, entryId: memory.id, expectedRevision: 1 }, 'feedback-stale'); }
catch (error: any) { conflictRejected = error.code === 'guidance_conflict'; }
if (!conflictRejected) throw Error('stale guidance correction was accepted');
let forgedSourceRejected = false;
try { await recordGuidance(serviceModule, actor, serviceProject.id, serviceAssignment.id, { guidance: 'Forged source.', source: { ...source, messageId: 'unknown' } }, 'feedback-forged'); }
catch (error: any) { forgedSourceRejected = error.code === 'feedback_source_not_found'; }
if (!forgedSourceRejected) throw Error('feedback with a nonexistent source was accepted');
const [history] = await database.unsafe<{ count: number }>('select count(*)::int as count from bp_memory_revisions where project_id=$1 and assignment_id=$2 and entry_id=$3', [serviceProject.id, serviceAssignment.id, memory.id]);
if (history.count !== 2) throw Error('feedback history was not retained');
let historyChangeRejected = false;
try { await database.unsafe('update bp_memory_revisions set guidance=$4 where project_id=$1 and assignment_id=$2 and entry_id=$3', [serviceProject.id, serviceAssignment.id, memory.id, 'rewritten']); }
catch { historyChangeRejected = true; }
if (!historyChangeRejected) throw Error('feedback history was mutable');
if ((await currentGuidance(serviceModule, actor, serviceProject.id, 'another-assignment')).length) throw Error('guidance leaked to another assignment');
await database.unsafe("insert into users values ('other')");
await database.unsafe("insert into bp_memberships(project_id,user_id,permissions) values ($1,'other',array['read','feedback'])", [serviceProject.id]);
if ((await currentGuidance(serviceModule, { id: 'other', role: 'user' }, serviceProject.id, serviceAssignment.id)).length) throw Error('guidance leaked without conversation membership');
let unmemberedFeedbackRejected = false;
try { await recordGuidance(serviceModule, { id: 'other', role: 'user' }, serviceProject.id, serviceAssignment.id, { guidance: 'Unauthorized.', source }, 'feedback-other'); }
catch (error: any) { unmemberedFeedbackRejected = error.code === 'feedback_source_not_found'; }
if (!unmemberedFeedbackRejected) throw Error('feedback accepted from a user without conversation access');
const routes = createProductRoutes(serviceModule, async (context: any, next: any) => { context.set('actor', actor); await next(); }, {} as any);
const apiFeedback = await routes.request(`/${serviceProject.id}/assignments/${serviceAssignment.id}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'feedback-api' }, body: JSON.stringify({ guidance: 'Keep reports concise.', source }) });
if (apiFeedback.status !== 200 || !(await apiFeedback.json() as any).memory?.id) throw Error('feedback route failed');
const archived = await routes.request(`/${serviceProject.id}/archive`, { method: 'POST' });
if (archived.status !== 200) throw Error('archive route failed');
await archiveProject(serviceModule, actor, serviceProject.id);
const [retained] = await database.unsafe<{ count: number }>('select count(*)::int as count from bp_work_items where project_id=$1', [serviceProject.id]);
if (retained.count !== 1) throw Error('archive did not preserve work history');
let archivedWorkRejected = false;
try { await saveWorkflowSelection(serviceModule, actor, serviceProject.id, selection, 'after-archive', schema); }
catch (error: any) { archivedWorkRejected = error.code === 'project_archived'; }
if (!archivedWorkRejected) throw Error('archived project accepted new work');
const installation = await store.ensureInstallation(actor, { environmentId: "test", blueprintKey: "swe", composeProject: "test", appUrl: "http://localhost" });
const role = { id: "qa", agentId: "qa-bot", startupChecks: [{ id: "check", kind: "role-ready" }, { id: "workspace", kind: "workspace-ready" }] };
const business = { teamLeadRole: "qa", roles: [role], artifactTypes: [{ id: "source-code", description: "source code", schema: { type: "object", properties: { path: { type: "string", minLength: 1 }, revision: { type: "string" } }, required: ["path"], additionalProperties: false } }, { id: "service-context", description: "service context", schema: { type: "object", properties: { status: { type: "string" } }, required: ["status"], additionalProperties: false } }], initialization: { requiredArtifacts: ["source-code"], workspace: { kind: "vm" } } };
await store.registerBlueprint(actor, { key: "swe", version: "1", digest: "fixture", definition: { id: "swe" } });
const module = { database, store, definition: { version: "1" }, ensure: async () => installation.id, definitionFor: async () => ({ business }) };
const operations = projectOperations(module as any, async input => {
  await database.unsafe("insert into channels(id) values($1)", ["channel-" + input.projectId]);
  await database.unsafe("insert into bp_conversations(project_id,native_channel_id,team_lead_assignment_id) values($1,$2,$3)", [input.projectId, "channel-" + input.projectId, input.assignmentId]);
});
const first = await operations.create(actor, { name: "first" }, "one");
const retry = await operations.create(actor, { name: "first" }, "one");
const second = await operations.create(actor, { name: "second" }, "two");
if (first.id !== retry.id || first.id === second.id) throw Error("project identity or retry failed");
let invalidArtifactRejected = false;
try { await operations.initialize(actor, first.id, { "source-code": { path: "/projects/source", extra: "unexpected" } } as any); }
catch (error: any) { invalidArtifactRejected = error.code === 'invalid_artifact'; }
if (!invalidArtifactRejected) throw Error('an artifact outside its declared schema was accepted');
let suppliedRevisionRejected = false;
try { await operations.initialize(actor, first.id, { "source-code": { path: "/projects/source", revision: "unverified" } }); }
catch (error: any) { suppliedRevisionRejected = error.code === 'invalid_artifact'; }
if (!suppliedRevisionRejected) throw Error('an unverified source revision was accepted');
const [assignment] = await database.unsafe<{ id: string }>('select id from bp_assignments where project_id=$1 limit 1', [first.id]);
await database.unsafe('insert into bp_work_items(project_id,id,native_channel_id,requested_by,request) values($1,$2,$3,$4,$5)', [first.id, 'item', 'channel-' + first.id, actor.id, 'Test request']);
await database.unsafe('insert into bp_workflow_runs(project_id,id,work_item_id,blueprint_key,blueprint_version,plan_digest,plan,current_phase,state) values($1,$2,$3,$4,$5,$6,$7::text::jsonb,$8,$9)', [first.id, 'run', 'item', 'swe', '1', 'digest', '{}', 'start', 'Running']);
await database.unsafe('insert into bp_phase_occurrences(project_id,run_id,id,phase_key,occurrence,action_key,assignment_id,operation_key) values($1,$2,$3,$4,$5,$6,$7,$8)', [first.id, 'run', 'phase', 'start', 1, 'act', assignment.id, 'stable-operation']);
await database.unsafe('insert into bp_action_attempts(project_id,run_id,occurrence_id,attempt,state) values($1,$2,$3,$4,$5)', [first.id, 'run', 'phase', 1, 'Pending']);
await database.unsafe('insert into bp_dispatch_intents(project_id,run_id,occurrence_id,attempt,operation_key,state) values($1,$2,$3,$4,$5,$6)', [first.id, 'run', 'phase', 1, 'stable-operation', 'Pending']);
let changedPlanRejected = false;
try { await database.unsafe('update bp_workflow_runs set plan=$3::text::jsonb where project_id=$1 and id=$2', [first.id, 'run', '{"changed":true}']); }
catch { changedPlanRejected = true; }
if (!changedPlanRejected) throw Error('a pinned run plan was mutable');
let wrongOperationRejected = false;
await database.unsafe('insert into bp_action_attempts(project_id,run_id,occurrence_id,attempt,state) values($1,$2,$3,$4,$5)', [first.id, 'run', 'phase', 2, 'Pending']);
try { await database.unsafe('insert into bp_dispatch_intents(project_id,run_id,occurrence_id,attempt,operation_key,state) values($1,$2,$3,$4,$5,$6)', [first.id, 'run', 'phase', 2, 'different-operation', 'Pending']); }
catch { wrongOperationRejected = true; }
if (!wrongOperationRejected) throw Error('a retry changed its operation key');
let changedPhaseRejected = false;
try { await database.unsafe('update bp_phase_occurrences set operation_key=$4 where project_id=$1 and run_id=$2 and id=$3', [first.id, 'run', 'phase', 'other']); }
catch { changedPhaseRejected = true; }
if (!changedPhaseRejected) throw Error('a phase occurrence identity was mutable');
await database.unsafe('insert into bp_workflow_transitions(project_id,run_id,sequence,from_phase,to_phase) values($1,$2,$3,$4,$5)', [first.id, 'run', 1, 'start', 'done']);
let transitionDeletionRejected = false;
try { await database.unsafe('delete from bp_workflow_transitions where project_id=$1 and run_id=$2', [first.id, 'run']); }
catch { transitionDeletionRejected = true; }
if (!transitionDeletionRejected) throw Error('a workflow transition was deletable');
let incompleteDecisionRejected = false;
try { await database.unsafe('insert into bp_workflow_decisions(project_id,run_id,id,question,state,answer) values($1,$2,$3,$4,$5,$6::text::jsonb)', [first.id, 'run', 'decision', 'Choose?', 'Pending', '{"partial":true}']); }
catch { incompleteDecisionRejected = true; }
if (!incompleteDecisionRejected) throw Error('a pending decision accepted a partial answer');
let imports = 0;
let guestRevision = "source-1";
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const input = await request.json() as { projectId: string; source?: string; expectedRevision?: string; replace?: boolean };
    if (new URL(request.url).pathname === "/source") return Response.json({ revision: guestRevision, hasProject: true });
    if (new URL(request.url).pathname === "/import") {
      imports++;
      await Bun.sleep(30);
      if (input.source === "/projects/other") {
        if (!input.replace || input.expectedRevision !== "source-1") throw Error("source replacement was not bound to the old revision");
        guestRevision = "source-2";
        return Response.json({ revision: "source-2" });
      }
      return Response.json({ revision: "source-1" });
    }
    return Response.json({ id: "vm-" + input.projectId, ready: true, isolated: true });
  },
});
process.env.WORKSPACE_PROVIDER_URL = "http://127.0.0.1:" + server.port;
process.env.WORKSPACE_PROVIDER_TOKEN = "fixture-token";
await Promise.all([
  operations.initialize(actor, first.id, { "source-code": { path: "/projects/source" }, "service-context": { status: "active" } }),
  operations.initialize(actor, first.id, { "source-code": { path: "/projects/source" } }),
]);
if (imports !== 1) throw Error("concurrent initialization imported twice");
const status = await readinessOperations(module as any).refresh(actor, first.id);
if (status.project.state !== "Initializing" || status.reports[0]?.status !== "Blocked") throw Error("missing bot report did not block");
const ready = await readinessOperations(module as any, async () => ({ ready: true, checks: [{ id: "check", passed: true, evidence: "bot checked" }, { id: "workspace", passed: true, evidence: "workspace checked" }] })).refresh(actor, first.id);
if (ready.project.state !== "Operational") throw Error("readiness did not activate");
await operations.initialize(actor, first.id, { "source-code": { path: "/projects/other" } });
const [rebound] = await database.unsafe('select source_revision as "revision",imported_source_path as "path" from bp_project_vms where project_id=$1', [first.id]);
if (rebound.revision !== "source-2" || rebound.path !== "/projects/other") throw Error("source replacement was not persisted");
const changed = await readinessOperations(module as any).inspect(actor, first.id);
if (changed.project.state !== "Initializing" || changed.reports[0]?.status !== "Pending") throw Error("source replacement did not invalidate operational status and workspace readiness");
guestRevision = "source-1";
const beforeReconcile = imports;
await operations.initialize(actor, first.id, { "source-code": { path: "/projects/other" } });
if (imports !== beforeReconcile + 1 || guestRevision !== "source-2") throw Error("guest and database source state were not reconciled");
const [artifactRevision] = await database.unsafe<{ id: string }>('select id from bp_artifact_revisions where project_id=$1 and artifact_id=$2 limit 1', [first.id, 'source-code']);
await database.unsafe('insert into bp_release_proposals(project_id,run_id,id,candidate_artifact_id,candidate_revision_id,target,evidence,state) values($1,$2,$3,$4,$5,$6,$7::text::jsonb,$8)', [first.id, 'run', 'proposal', 'source-code', artifactRevision.id, 'staging', '{}', 'Pending']);
let wrongTargetRejected = false;
try { await database.unsafe('insert into bp_release_approvals(project_id,run_id,proposal_id,id,candidate_artifact_id,candidate_revision_id,target,approver_id,decision) values($1,$2,$3,$4,$5,$6,$7,$8,$9)', [first.id, 'run', 'proposal', 'approval', 'source-code', artifactRevision.id, 'production', actor.id, 'Approved']); }
catch { wrongTargetRejected = true; }
if (!wrongTargetRejected) throw Error('an approval accepted a different release target');
await database.unsafe('insert into bp_release_approvals(project_id,run_id,proposal_id,id,candidate_artifact_id,candidate_revision_id,target,approver_id,decision) values($1,$2,$3,$4,$5,$6,$7,$8,$9)', [first.id, 'run', 'proposal', 'approval', 'source-code', artifactRevision.id, 'staging', actor.id, 'Approved']);
await database.unsafe('insert into bp_release_effects(project_id,run_id,proposal_id,operation_key,state) values($1,$2,$3,$4,$5)', [first.id, 'run', 'proposal', 'release-operation', 'Pending']);
let changedKeyRejected = false;
try { await database.unsafe('update bp_release_effects set operation_key=$4 where project_id=$1 and run_id=$2 and proposal_id=$3', [first.id, 'run', 'proposal', 'changed']); }
catch { changedKeyRejected = true; }
if (!changedKeyRejected) throw Error('a release operation key was mutable');
console.log("Verified PostgreSQL project identity, concurrent source import, and readiness state.");
server.stop();
await client.close();
