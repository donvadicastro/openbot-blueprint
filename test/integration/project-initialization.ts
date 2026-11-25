import { readWorkItem } from '/app/server/src/product/work-query.ts';
import { SQL } from "bun";
import { contentDigest, createProductStore, productDatabaseFromNative } from "/app/server/src/product/store.ts";
import { projectOperations } from "/app/server/src/product/projects.ts";
import { readinessOperations } from "/app/server/src/product/readiness.ts";
import { createProductModule } from "/app/server/src/product/module.ts";
import { requireReadyReports } from "/app/server/src/product/readiness-gate.ts";
import { saveWorkflowSelection, selectWorkflow } from "/app/server/src/product/workflow-routing.ts";
import { archiveProject } from "/app/server/src/product/archive.ts";
import { dispatchPendingWorkflow } from "/app/server/src/product/workflow-engine.ts";
import { answerWorkflowDecision, dispatchPendingDecision } from "/app/server/src/product/workflow-decision.ts";
import { dispatchPendingReconciliation, reconcileWorkflow, readWorkflowEngineState } from "/app/server/src/product/workflow-reconcile.ts";
import { claimPhaseActivity, reconcilePhaseActivity, resolvePhaseActivity } from "/app/server/src/product/phase-activity.ts";
import { savePhaseOutput } from "/app/server/src/product/phase-output.ts";
import { recordPhaseResult } from "/app/server/src/product/phase-result.ts";
import { applyPhaseResult } from "/app/server/src/product/phase-transition.ts";
import { createPhaseExecutor } from "/app/server/src/product/phase-executor.ts";
import { bindPhaseMcpTools, phaseMcpPointerValue } from "/app/server/src/product/phase-mcp.ts";
import { reservePhaseWorkspace, runPhaseWorkspace } from "/app/server/src/product/phase-workspace.ts";
import { recordQaProgress } from "/app/server/src/product/qa-progress.ts";
import { readChatProjection } from "/app/server/src/product/chat-events.ts";
import { createRequireUser } from "/app/server/src/auth/guards.ts";
import { resolveWorkflowInputs } from "/app/server/src/product/workflow-inputs.ts";
import { requireReleaseInputs } from "/app/server/src/product/release-preflight.ts";
import { requireApprovedRelease } from "/app/server/src/product/release-effect.ts";
import { reconcileReleaseDeployment } from "/app/server/src/product/release-deployment.ts";
import { createWorkflowActivityRoutes } from "/app/server/src/product/workflow-activity-routes.ts";
import { botGuidance, currentGuidance, recordGuidance } from "/app/server/src/product/feedback.ts";
import { createProductRoutes } from "/app/server/src/product/routes.ts";
import { requireNativeBotContext } from "/app/server/src/product/native-context.ts";
import { callNativeProjectTool, nativeProjectTools } from "/app/server/src/product/native-project-tool.ts";
import { callNativeFeedbackTool } from "/app/server/src/product/native-feedback-tool.ts";
import { callNativeWorkflowTool } from "/app/server/src/product/native-workflow-tool.ts";
import { requireNativeWorkspaceAction } from "/app/server/src/product/native-action.ts";
import { callNativeWorkspaceTool, nativeWorkspaceTools } from "/app/server/src/product/native-workspace-tool.ts";
import { guardProjectDelegation } from "/app/server/src/product/delegation-guard.ts";
import { businessChannelContext } from "/app/server/src/product/channel-context.ts";
import { migrateLegacyProjects } from "/app/server/src/product/legacy-projects.ts";
import { authoriseAgentCall, hashCallbackToken, mintCallbackToken, mintRunAssertion } from "/app/server/src/agents/callback-token.ts";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PgDialect } from "/app/server/node_modules/drizzle-orm/pg-core/index.js";

const originalStagingEnv = { url: process.env.STAGING_TARGET_URL, token: process.env.STAGING_TARGET_TOKEN, id: process.env.STAGING_TARGET_ID };
delete process.env.STAGING_TARGET_URL;
delete process.env.STAGING_TARGET_TOKEN;
delete process.env.STAGING_TARGET_ID;

const client = new SQL({ hostname: "postgres", port: 5432, username: "postgres", password: "probe", database: "postgres" });
const database = productDatabaseFromNative({ $client: client });
const actor = { id: "owner", role: "admin" } as const;
if (phaseMcpPointerValue({ repository: { path: 'repo-a' } }, '/repository/path') !== 'repo-a' ||
    phaseMcpPointerValue({ repository: { path: 'repo-a' } }, '/repository/other') !== undefined) throw Error('phase MCP JSON Pointer binding is not exact');
let connectorCalls = 0, scopeChecks = 0;
const phaseMcpGrant = { toolId: 'repository-read', nativeRef: 'repo-server/read_file', resourceBindings: [
  { argumentPath: '/path', artifactType: 'brief', payloadPath: '/repository' },
] };
const scopedTools = bindPhaseMcpTools([
  { ref: 'repo-server/read_file', execute: async () => { connectorCalls++; return 'read'; } },
  { ref: 'other-server/delete_repository', execute: async () => { connectorCalls++; return 'delete'; } },
], [phaseMcpGrant], async (_grant, args) => {
  scopeChecks++;
  if ((args as { path?: string }).path !== 'repo-a') throw Error('resource outside visible artifact');
});
if (scopedTools.length !== 1 || scopedTools[0].ref !== phaseMcpGrant.nativeRef) throw Error('unconfigured native MCP ref reached the phase');
if (await scopedTools[0].execute({ path: 'repo-a' }) !== 'read' || connectorCalls !== 1 || scopeChecks !== 1) throw Error('authorized phase MCP call did not reach its exact connector');
if (!String(await scopedTools[0].execute({ path: 'other-repo' })).startsWith('Refused.') || connectorCalls !== 1 || scopeChecks !== 2) throw Error('unauthorized phase MCP call reached its connector');
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
  await database.unsafe('insert into channel_agents(channel_id,agent_id) values($1,$2)', [channel, input.nativeBotId]);
  await database.unsafe('insert into bp_conversations(project_id,native_channel_id,team_lead_assignment_id) values($1,$2,$3)', [input.projectId, channel, input.assignmentId]);
});
const serviceProject = await serviceProjects.create(actor, { name: 'service' }, 'service-project');
const serviceChannel = await businessChannelContext(serviceModule, actor, 'channel-' + serviceProject.id);
if (serviceChannel?.id !== serviceProject.id || !serviceChannel.isTeamLead) throw Error('project chat was not identified as the Team Lead conversation');
if (await businessChannelContext(serviceModule, actor, 'not-a-project-channel') !== null) throw Error('a nonproject conversation was identified as a project');
await database.unsafe("insert into bp_artifacts(project_id,id,type_key,source,status,allowed_user_ids) values($1,'service-artifact','service-request','{}'::jsonb,'supplied',array['owner'])", [serviceProject.id]);
await database.unsafe("insert into bp_artifact_revisions(project_id,artifact_id,id,digest,payload,created_by) values($1,'service-artifact','revision','digest','{\"status\":\"ready\"}'::jsonb,'owner')", [serviceProject.id]);
const visibleArtifact = await store.resolveBotArtifact(actor, 'channel-' + serviceProject.id, 'team-lead', 'service-artifact', 'revision');
if (visibleArtifact.id !== 'revision') throw Error('authorized bot could not resolve the project artifact');
await database.unsafe("insert into bp_assignments(project_id,id,role_key,native_bot_id) values($1,'ambiguous-assignment','other-role','team-lead')", [serviceProject.id]);
const [leadAssignment] = await database.unsafe<{ id: string }>("select id from bp_assignments where project_id=$1 and role_key='team-lead'", [serviceProject.id]);
let ambiguousBotRejected = false;
try { await store.resolveBotArtifact(actor, 'channel-' + serviceProject.id, 'team-lead', 'service-artifact', 'revision'); }
catch (error: any) { ambiguousBotRejected = error.code === 'project_not_found'; }
if (!ambiguousBotRejected) throw Error('ambiguous shared bot assignment was accepted');
if ((await store.resolveBotArtifact(actor, 'channel-' + serviceProject.id, 'team-lead', 'service-artifact', 'revision', leadAssignment.id)).id !== 'revision') throw Error('trusted assignment did not resolve the shared bot role');
let wrongRoleRejected = false;
try { await store.resolveBotArtifact(actor, 'channel-' + serviceProject.id, 'team-lead', 'service-artifact', 'revision', 'ambiguous-assignment'); }
catch (error: any) { wrongRoleRejected = error.code === 'artifact_not_found'; }
if (!wrongRoleRejected) throw Error('shared bot used the wrong assignment role grant');
await database.unsafe("delete from bp_assignments where project_id=$1 and id='ambiguous-assignment'", [serviceProject.id]);
let wrongBotRejected = false;
try { await store.resolveBotArtifact(actor, 'channel-' + serviceProject.id, 'unknown-bot', 'service-artifact', 'revision'); }
catch (error: any) { wrongBotRejected = error.code === 'project_not_found'; }
if (!wrongBotRejected) throw Error('unassigned bot could access the project artifact');
await database.unsafe("update bp_artifacts set allowed_user_ids=array['other'] where project_id=$1 and id='service-artifact'", [serviceProject.id]);
let restrictedArtifactRejected = false;
try { await store.resolveBotArtifact(actor, 'channel-' + serviceProject.id, 'team-lead', 'service-artifact', 'revision'); }
catch (error: any) { restrictedArtifactRejected = error.code === 'artifact_not_found'; }
if (!restrictedArtifactRejected) throw Error('bot could access an artifact hidden from its actor');
await database.unsafe("update bp_artifacts set allowed_user_ids=array['owner'] where project_id=$1 and id='service-artifact'", [serviceProject.id]);
await database.unsafe("update bp_projects set state='Operational' where id=$1", [serviceProject.id]);
await database.unsafe("insert into bp_readiness(project_id,assignment_id,assignment_revision,input_digest,status,evidence) select project_id,id,revision,'fixture','Ready','{}'::jsonb from bp_assignments where project_id=$1", [serviceProject.id]);
await database.unsafe("update bp_assignments set revision=revision+1 where project_id=$1 and role_key='team-lead'", [serviceProject.id]);
if ((await store.listProjects(actor)).find(item => item.id === serviceProject.id)?.state !== 'Initializing') throw Error('project list showed stale assignment readiness as operational');
await database.unsafe("update bp_readiness r set assignment_revision=a.revision from bp_assignments a where r.project_id=a.project_id and r.assignment_id=a.id and r.project_id=$1", [serviceProject.id]);
if ((await store.listProjects(actor)).find(item => item.id === serviceProject.id)?.state !== 'Operational') throw Error('project list did not reflect current readiness');
const schema = JSON.parse(await readFile('/app/server/src/product/contract/blueprint.schema.json', 'utf8'));
const selection = { channelId: 'channel-' + serviceProject.id, request: 'Handle a service request', interpretation: { workflowId: 'service-request' } };
const firstSelection = await saveWorkflowSelection(serviceModule, actor, serviceProject.id, selection, 'route-once', schema);
const repeatedSelection = await saveWorkflowSelection(serviceModule, actor, serviceProject.id, selection, 'route-once', schema);
if (firstSelection.status !== 'saved' || repeatedSelection.status !== 'saved' || firstSelection.runId !== repeatedSelection.runId) throw Error('workflow routing was not idempotent');
let bindingChecks = 0;
const checkBinding = async () => { bindingChecks++; };
const boundReplay = await saveWorkflowSelection(serviceModule, actor, serviceProject.id, selection, 'route-once', schema, checkBinding);
if (bindingChecks !== 1 || firstSelection.runId !== boundReplay.runId) throw Error('Workflow binding was not rechecked on replay');
let revokedBindingRejected = false;
try { await saveWorkflowSelection(serviceModule, actor, serviceProject.id, selection, 'route-once', schema, async () => { throw Error('binding revoked'); }); }
catch { revokedBindingRejected = true; }
if (!revokedBindingRejected) throw Error('Workflow replay ignored a revoked native binding');
let revokedCreationRejected = false;
try { await saveWorkflowSelection(serviceModule, actor, serviceProject.id, selection, 'revoked-creation', schema, async () => { throw Error('binding revoked'); }); }
catch { revokedCreationRejected = true; }
if (!revokedCreationRejected) throw Error('New workflow ignored a revoked native binding');
await database.unsafe("update bp_readiness set status='Blocked' where project_id=$1", [serviceProject.id]);
let staleWorkRejected = false;
try { await saveWorkflowSelection(serviceModule, actor, serviceProject.id, selection, 'blocked-work', schema); }
catch (error: any) { staleWorkRejected = error.code === 'readiness_stale'; }
if (!staleWorkRejected) throw Error('new work was accepted with blocked readiness');
await database.unsafe("update bp_readiness set status='Ready' where project_id=$1", [serviceProject.id]);
await database.unsafe('delete from channel_memberships where channel_id=$1 and user_id=$2', [selection.channelId, actor.id]);
let revokedReplayRejected = false;
try { await saveWorkflowSelection(serviceModule, actor, serviceProject.id, selection, 'route-once', schema); }
catch (error: any) { revokedReplayRejected = error.code === 'conversation_not_found'; }
if (!revokedReplayRejected) throw Error('workflow replay leaked a result after conversation access was revoked');
await database.unsafe('insert into channel_memberships(channel_id,user_id) values ($1,$2)', [selection.channelId, actor.id]);
let dispatchedIdentity: any;
const engine = Bun.serve({ port: 0, async fetch(request) { dispatchedIdentity = await request.json(); const run = (dispatchedIdentity as any).run; return Response.json({ workflowId: 'openbot-' + createHash('sha256').update(JSON.stringify([run.installationId, run.projectId, run.runId])).digest('hex'), existing: false }); } });
process.env.WORKFLOW_ENGINE_URL = 'http://127.0.0.1:' + engine.port;
process.env.WORKFLOW_ENGINE_TOKEN = 'x'.repeat(32);
await database.unsafe("update bp_assignments set native_bot_id='wrong-bot' where project_id=$1 and role_key='coordinator'", [serviceProject.id]);
let changedBotRejected = false;
try { await dispatchPendingWorkflow(serviceModule); } catch (error: any) { changedBotRejected = error.code === 'assignment_unavailable'; }
if (!changedBotRejected || dispatchedIdentity) throw Error('dispatch accepted a specialist different from the pinned blueprint');
const [delayed] = await database.unsafe<{ failures: number; delayed: boolean }>("select dispatch_failures as failures,next_attempt_at>now() as delayed from bp_dispatch_intents where project_id=$1 and run_id=$2", [serviceProject.id, firstSelection.runId]);
if (delayed.failures !== 1 || !delayed.delayed) throw Error('failed workflow dispatch did not receive retry backoff');
await database.unsafe("update bp_assignments set native_bot_id='lead' where project_id=$1 and role_key='coordinator'", [serviceProject.id]);
const laterSelection = await saveWorkflowSelection(serviceModule, actor, serviceProject.id, selection, 'route-later', schema);
if (laterSelection.status !== 'saved' || !await dispatchPendingWorkflow(serviceModule) || dispatchedIdentity.run.runId !== laterSelection.runId) throw Error('backed-off workflow prevented another project run from dispatching');
await database.unsafe("update bp_dispatch_intents set next_attempt_at=now() where project_id=$1 and run_id=$2", [serviceProject.id, firstSelection.runId]);
if (!await dispatchPendingWorkflow(serviceModule)) throw Error('pending workflow was not dispatched');
if (dispatchedIdentity.run.projectId !== serviceProject.id || dispatchedIdentity.run.runId !== firstSelection.runId) throw Error('workflow dispatch lost its project binding');
const phaseRequest = { ...dispatchedIdentity.run, phase: dispatchedIdentity.run.initialPhase, occurrence: 1, operationKey: `${firstSelection.runId}:1` };
const resolvedPhase = await database.begin(tx => resolvePhaseActivity(tx, phaseRequest));
if (resolvedPhase.botId !== 'lead' || resolvedPhase.actorId !== actor.id || resolvedPhase.actionId !== 'clarify') throw Error('worker phase did not resolve the pinned specialist');
const workerToken = 'worker-test-token-01234567890123456789';
const activityRoutes = createWorkflowActivityRoutes(workerToken, {
  execute: async request => { await database.begin(tx => resolvePhaseActivity(tx, request)); return { kind: 'blocked', reason: 'Fixture only.' }; },
  reconcile: async () => ({ kind: 'not-started' }),
});
const activityRequest = (token: string, body: string) => activityRoutes.request('/execute', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body });
if ((await activityRequest('wrong', JSON.stringify(phaseRequest))).status !== 401) throw Error('activity endpoint accepted an invalid token');
if ((await activityRequest(workerToken, 'x'.repeat(65537))).status !== 413) throw Error('activity endpoint accepted an oversized request');
const activityResult = await activityRequest(workerToken, JSON.stringify(phaseRequest));
if (activityResult.status !== 200 || (await activityResult.json() as any).kind !== 'blocked') throw Error('authenticated activity did not reach its handler');
if ((await activityRequest(workerToken, JSON.stringify({ ...phaseRequest, operationKey: 'forged' }))).status !== 503) throw Error('activity transport accepted an unverified phase');
let forgedPhaseRejected = false;
try { await database.begin(tx => resolvePhaseActivity(tx, { ...phaseRequest, operationKey: 'forged' })); } catch (error: any) { forgedPhaseRejected = error.code === 'phase_unavailable'; }
if (!forgedPhaseRejected) throw Error('worker phase accepted a forged operation key');
await database.unsafe("update bp_dispatch_intents set state='Completed' where project_id=$1 and run_id=$2", [serviceProject.id, firstSelection.runId]);
let completedPhaseRejected = false;
try { await database.begin(tx => resolvePhaseActivity(tx, phaseRequest)); } catch (error: any) { completedPhaseRejected = error.code === 'phase_unavailable'; }
if (!completedPhaseRejected) throw Error('worker phase accepted an already completed attempt');
await database.unsafe("update bp_dispatch_intents set state='Dispatched' where project_id=$1 and run_id=$2", [serviceProject.id, firstSelection.runId]);
if ((await database.begin(tx => reconcilePhaseActivity(tx, phaseRequest))).kind !== 'not-started') throw Error('unclaimed phase was not recognized');
const claims = await Promise.all([
  database.begin(tx => claimPhaseActivity(tx, phaseRequest)),
  database.begin(tx => claimPhaseActivity(tx, phaseRequest)),
]);
if (claims.map(claim => claim.status).sort().join(',') !== 'claimed,uncertain') throw Error('concurrent phase dispatch was not claimed exactly once');
const phaseOutput = await database.begin(tx => savePhaseOutput(tx, phaseRequest, 'service-request', { status: 'ready' }));
const repeatedOutput = await database.begin(tx => savePhaseOutput(tx, phaseRequest, 'service-request', { status: 'ready' }));
if (phaseOutput.revisionId !== repeatedOutput.revisionId) throw Error('replayed phase output created another revision');
let invalidOutputRejected = false;
try { await database.begin(tx => savePhaseOutput(tx, phaseRequest, 'service-request', { status: 'invalid' })); } catch (error: any) { invalidOutputRejected = error.code === 'invalid_output'; }
if (!invalidOutputRejected) throw Error('phase output bypassed its declared schema');
let unauthorizedOutputRejected = false;
try { await database.begin(tx => savePhaseOutput(tx, phaseRequest, 'unknown', {})); } catch (error: any) { unauthorizedOutputRejected = error.code === 'output_denied'; }
if (!unauthorizedOutputRejected) throw Error('phase output bypassed its declared role');
const typedResult = { projectId: serviceProject.id, runId: firstSelection.runId, occurrenceId: resolvedPhase.occurrenceId,
  assignmentId: resolvedPhase.assignmentId, actionId: resolvedPhase.actionId, attempt: resolvedPhase.attempt,
  runRevision: resolvedPhase.runRevision, status: 'succeeded', outputs: [{ type: 'service-request', revisionId: phaseOutput.revisionId }],
  evidence: { confirmed: phaseOutput.revisionId } };
const recordedResult = await database.begin(tx => recordPhaseResult(tx, phaseRequest, typedResult));
const replayedResult = await database.begin(tx => recordPhaseResult(tx, phaseRequest, typedResult));
if (recordedResult.replayed || !replayedResult.replayed) throw Error('typed result did not deduplicate an exact retry');
let staleResultRejected = false;
try { await database.begin(tx => recordPhaseResult(tx, phaseRequest, { ...typedResult, runRevision: typedResult.runRevision - 1 })); }
catch (error: any) { staleResultRejected = error.code === 'stale_action_result'; }
if (!staleResultRejected) throw Error('stale typed result was accepted');
let forgedEvidenceRejected = false;
try { await database.begin(tx => recordPhaseResult(tx, phaseRequest, { ...typedResult, evidence: { confirmed: 'forged' } })); }
catch (error: any) { forgedEvidenceRejected = error.code === 'invalid_action_result'; }
if (!forgedEvidenceRejected) throw Error('typed result accepted unauthorized evidence');
const [laterRun] = await database.unsafe<{ planDigest: string }>('select plan_digest as "planDigest" from bp_workflow_runs where project_id=$1 and id=$2', [serviceProject.id, laterSelection.runId]);
const laterRequest = { installationId: phaseRequest.installationId, projectId: serviceProject.id, runId: laterSelection.runId,
  planDigest: laterRun.planDigest, phase: 'clarify', occurrence: 1, operationKey: `${laterSelection.runId}:1` };
const laterClaim = await database.begin(tx => claimPhaseActivity(tx, laterRequest));
if (laterClaim.status !== 'claimed') throw Error('second workflow phase was not claimed');
const laterOutput = await database.begin(tx => savePhaseOutput(tx, laterRequest, 'service-request', { status: 'ready' }));
if (laterOutput.revisionId === phaseOutput.revisionId) throw Error('different workflow outputs shared a revision identity');
const laterResult = { ...typedResult, runId: laterSelection.runId, occurrenceId: laterClaim.phase.occurrenceId,
  assignmentId: laterClaim.phase.assignmentId, actionId: laterClaim.phase.actionId, attempt: laterClaim.phase.attempt,
  runRevision: laterClaim.phase.runRevision, outputs: [{ type: 'service-request', revisionId: laterOutput.revisionId }], evidence: { confirmed: laterOutput.revisionId } };
await database.begin(tx => recordPhaseResult(tx, laterRequest, laterResult));
const complete = await database.begin(tx => applyPhaseResult(tx, laterRequest, laterResult));
const completeAgain = await database.begin(tx => applyPhaseResult(tx, laterRequest, laterResult));
if ((complete as any).kind !== 'complete' || JSON.stringify(complete) !== JSON.stringify(completeAgain)) throw Error('workflow completion was not idempotent');
let changedCompletedResultRejected = false;
try { await database.begin(tx => applyPhaseResult(tx, laterRequest, { ...laterResult, status: 'failed' })); }
catch (error: any) { changedCompletedResultRejected = error.code === 'result_unavailable'; }
if (!changedCompletedResultRejected) throw Error('completed workflow accepted a different result on replay');
const chainDefinition = structuredClone(serviceDefinition);
chainDefinition.version = '1.0.2';
chainDefinition.agents.find((agent: any) => agent.id === 'lead').tools.push('test-runner', 'workspace-edit');
chainDefinition.business.actions[0].results.push({ status: 'needs-input', requiredOutputTypes: [], requiredEvidence: [] });
chainDefinition.business.roles.find((role: any) => role.id === 'coordinator').actions.push('review');
chainDefinition.business.actions.push({ ...structuredClone(chainDefinition.business.actions[0]), id: 'review', inputTypes: ['service-request'] });
chainDefinition.business.workflows[0].phases.splice(1, 0, { id: 'review', action: 'review' });
chainDefinition.business.workflows[0].transitions = [
  { from: 'clarify', to: 'review', when: { status: 'succeeded' } },
  { from: 'review', to: 'done', when: { status: 'succeeded' } },
];
await serviceModule.publish(actor, chainDefinition);
const chainProject = await serviceProjects.create(actor, { name: 'chain', blueprintVersion: '1.0.2' }, 'chain-project');
await database.unsafe("update bp_projects set state='Operational' where id=$1", [chainProject.id]);
await database.unsafe("insert into bp_readiness(project_id,assignment_id,assignment_revision,input_digest,status,evidence) select project_id,id,revision,'fixture','Ready','{}'::jsonb from bp_assignments where project_id=$1", [chainProject.id]);
const chainSelection = await saveWorkflowSelection(serviceModule, actor, chainProject.id, { ...selection, channelId: `channel-${chainProject.id}` }, 'chain-work', schema);
await database.unsafe("update bp_workflow_runs set state='Running',revision=revision+1 where project_id=$1 and id=$2", [chainProject.id, chainSelection.runId]);
await database.unsafe("update bp_dispatch_intents set state='Dispatched' where project_id=$1 and run_id=$2", [chainProject.id, chainSelection.runId]);
const [chainRun] = await database.unsafe<{ installationId: string; planDigest: string }>(`select p.installation_id as "installationId",r.plan_digest as "planDigest"
  from bp_workflow_runs r join bp_projects p on p.id=r.project_id where r.project_id=$1 and r.id=$2`, [chainProject.id, chainSelection.runId]);
const chainRequest = { installationId: chainRun.installationId, projectId: chainProject.id, runId: chainSelection.runId as string,
  planDigest: chainRun.planDigest, phase: 'clarify', occurrence: 1, operationKey: `${chainSelection.runId}:1` };
const phaseBeforeConflict = await database.begin(tx => resolvePhaseActivity(tx, chainRequest));
const chainChannel = `channel-${chainProject.id}`;
const privateFeedbackChannel = `private-feedback-${chainProject.id}`;
await database.unsafe('insert into channels(id) values($1)', [privateFeedbackChannel]);
await database.unsafe('insert into channel_memberships(channel_id,user_id) values($1,$2)', [privateFeedbackChannel, actor.id]);
await database.unsafe('insert into bp_conversations(project_id,native_channel_id,team_lead_assignment_id) select project_id,$2,team_lead_assignment_id from bp_conversations where project_id=$1 and native_channel_id=$3', [chainProject.id, privateFeedbackChannel, chainChannel]);
for (const message of ['phase-feedback-1', 'phase-feedback-3']) await database.unsafe("insert into group_messages values ($1,$2,$3,null,'completed')", [message, chainChannel, actor.id]);
await database.unsafe("insert into group_messages values ('phase-feedback-2',$1,$2,null,'completed')", [privateFeedbackChannel, actor.id]);
const phaseMemory = await recordGuidance(serviceModule, actor, chainProject.id, phaseBeforeConflict.assignmentId, { guidance: 'Use brief reports.', source: { conversationId: chainChannel, messageId: 'phase-feedback-1' } }, 'phase-feedback-create');
const phaseConflict = await recordGuidance(serviceModule, actor, chainProject.id, phaseBeforeConflict.assignmentId, { guidance: 'Use detailed reports.', source: { conversationId: privateFeedbackChannel, messageId: 'phase-feedback-2' }, entryId: phaseMemory.id, expectedRevision: 1, conflict: true }, 'phase-feedback-conflict');
let phaseConflictBlocked = false;
try { await database.begin(tx => claimPhaseActivity(tx, chainRequest)); } catch (error: any) { phaseConflictBlocked = error.code === 'guidance_conflict_pending'; }
if (!phaseConflictBlocked) throw Error('specialist work continued while feedback was ambiguous');
const conflictRoutes = createProductRoutes(serviceModule, async (context: any, next: any) => { context.set('actor', actor); await next(); }, {} as any);
const conflictWork = await conflictRoutes.request(`/${chainProject.id}/work-items/${chainSelection.itemId}`);
if (!(await conflictWork.json() as any).workItem.runs.some((run: any) => run.attempts.some((attempt: any) => attempt.feedbackClarification))) throw Error('visible feedback conflict was not reported as a work blocker');
await database.unsafe("insert into users values ('work-observer')");
await database.unsafe("insert into bp_memberships(project_id,user_id,permissions) values ($1,'work-observer',array['read'])", [chainProject.id]);
await database.unsafe("insert into channel_memberships(channel_id,user_id) values ($1,'work-observer')", [chainChannel]);
const observerRoutes = createProductRoutes(serviceModule, async (context: any, next: any) => { context.set('actor', { id: 'work-observer', role: 'user' }); await next(); }, {} as any);
const observerWork = await observerRoutes.request(`/${chainProject.id}/work-items/${chainSelection.itemId}`);
if ((await observerWork.json() as any).workItem.runs.some((run: any) => run.attempts.some((attempt: any) => attempt.feedbackClarification))) throw Error('work view leaked a conflict from a private feedback conversation');
await recordGuidance(serviceModule, actor, chainProject.id, phaseBeforeConflict.assignmentId, { guidance: 'Use detailed reports for failures.', source: { conversationId: chainChannel, messageId: 'phase-feedback-3' }, entryId: phaseMemory.id, expectedRevision: 1, resolveConflictId: phaseConflict.conflictId }, 'phase-feedback-resolve');
let wakeCalls = 0;
const wakeEngine = Bun.serve({ port: 0, async fetch(request) { const body = await request.json() as any; if (new URL(request.url).pathname === '/reconcile' && body.run.runId === chainSelection.runId) wakeCalls++; return Response.json({ accepted: true }); } });
const originalEngine = process.env.WORKFLOW_ENGINE_URL;
process.env.WORKFLOW_ENGINE_URL = `http://127.0.0.1:${wakeEngine.port}`;
await database.unsafe('delete from channel_memberships where channel_id=$1 and user_id=$2', [chainChannel, actor.id]);
if (await dispatchPendingReconciliation(serviceModule)) throw Error('feedback wake-up ignored revoked conversation access');
await database.unsafe('insert into channel_memberships(channel_id,user_id) values($1,$2)', [chainChannel, actor.id]);
if (!await dispatchPendingReconciliation(serviceModule) || await dispatchPendingReconciliation(serviceModule) || wakeCalls !== 1) throw Error('feedback clarification did not queue one authorized reconciliation');
process.env.WORKFLOW_ENGINE_URL = originalEngine; wakeEngine.stop();
const chainClaim = await database.begin(tx => claimPhaseActivity(tx, chainRequest));
if (chainClaim.status !== 'claimed') throw Error('chain phase was not claimed');
const phaseProviderCalls: any[] = [];
let phaseProviderOutput = 'ok';
const phaseProvider = Bun.serve({ port: 0, async fetch(request) {
  const payload = await request.json(); phaseProviderCalls.push({ path: new URL(request.url).pathname, payload });
  return Response.json(new URL(request.url).pathname === '/check' ? { id: 'chain-vm', ready: true, isolated: true } : { status: 'completed', exitCode: 0, stdout: phaseProviderOutput, stderr: '' });
} });
const savedProviderEnv = { url: process.env.WORKSPACE_PROVIDER_URL, token: process.env.WORKSPACE_PROVIDER_TOKEN, installation: process.env.WORKSPACE_PROVIDER_INSTALLATION_ID };
process.env.WORKSPACE_PROVIDER_URL = `http://127.0.0.1:${phaseProvider.port}`; process.env.WORKSPACE_PROVIDER_TOKEN = 'fixture-token'; delete process.env.WORKSPACE_PROVIDER_INSTALLATION_ID;
await database.unsafe("update bp_project_vms set provider_id='chain-vm',state='Ready' where project_id=$1", [chainProject.id]);
await database.begin(tx => reservePhaseWorkspace(tx, chainRequest, 'test-runner', ['true']));
let changedCommandRejected = false;
try { await database.begin(tx => reservePhaseWorkspace(tx, chainRequest, 'test-runner', ['false'])); } catch (error: any) { changedCommandRejected = error.code === 'workspace_command_conflict'; }
if (!changedCommandRejected) throw Error('workspace reservation accepted a changed command');
const phaseRun = await database.begin(tx => runPhaseWorkspace(serviceModule, tx, chainRequest, 'test-runner', ['true']));
const phaseReconcile = await database.begin(tx => runPhaseWorkspace(serviceModule, tx, chainRequest, 'test-runner'));
if (phaseRun.status !== 'completed' || phaseReconcile.status !== 'completed' || phaseProviderCalls.filter(call => ['/run','/reconcile'].includes(call.path))[0].payload.operationKey !== phaseProviderCalls.filter(call => ['/run','/reconcile'].includes(call.path))[1].payload.operationKey) throw Error('phase workspace action did not preserve its effect identity');
if (!phaseRun.evidenceId || phaseRun.evidenceId !== phaseReconcile.evidenceId) throw Error('workspace evidence was not stable across reconciliation');
let workspaceEvidenceImmutable = false;
try { await database.unsafe("update bp_phase_workspace_evidence set stdout='forged' where project_id=$1 and evidence_id=$2", [chainProject.id, phaseRun.evidenceId]); }
catch { workspaceEvidenceImmutable = true; }
if (!workspaceEvidenceImmutable) throw Error('workspace execution evidence was mutable');
phaseProviderOutput = 'changed';
let changedReceiptRejected = false;
try { await database.begin(tx => runPhaseWorkspace(serviceModule, tx, chainRequest, 'test-runner')); } catch (error: any) { changedReceiptRejected = error.code === 'workspace_evidence_conflict'; }
if (!changedReceiptRejected) throw Error('workspace reconciliation accepted a changed receipt');
phaseProviderOutput = 'ok';
let phaseToolChangeRejected = false;
try { await database.begin(tx => runPhaseWorkspace(serviceModule, tx, chainRequest, 'workspace-edit', ['true'])); } catch (error: any) { phaseToolChangeRejected = error.code === 'workspace_tool_conflict'; }
if (!phaseToolChangeRejected) throw Error('phase workspace accepted a changed tool grant');
phaseProvider.stop();
if (savedProviderEnv.url === undefined) delete process.env.WORKSPACE_PROVIDER_URL; else process.env.WORKSPACE_PROVIDER_URL = savedProviderEnv.url;
if (savedProviderEnv.token === undefined) delete process.env.WORKSPACE_PROVIDER_TOKEN; else process.env.WORKSPACE_PROVIDER_TOKEN = savedProviderEnv.token;
if (savedProviderEnv.installation === undefined) delete process.env.WORKSPACE_PROVIDER_INSTALLATION_ID; else process.env.WORKSPACE_PROVIDER_INSTALLATION_ID = savedProviderEnv.installation;
const chainOutput = await database.begin(tx => savePhaseOutput(tx, chainRequest, 'service-request', { status: 'ready' }));
const chainResult = { projectId: chainProject.id, runId: chainRequest.runId, occurrenceId: chainClaim.phase.occurrenceId,
  assignmentId: chainClaim.phase.assignmentId, actionId: chainClaim.phase.actionId, attempt: chainClaim.phase.attempt,
  runRevision: chainClaim.phase.runRevision, status: 'succeeded', outputs: [{ type: 'service-request', revisionId: chainOutput.revisionId }],
  evidence: { confirmed: chainOutput.revisionId } };
await database.begin(tx => recordPhaseResult(tx, chainRequest, chainResult));
const chainAdvance: any = await database.begin(tx => applyPhaseResult(tx, chainRequest, chainResult));
if (chainAdvance.kind !== 'advance' || chainAdvance.nextPhase !== 'review') throw Error('workflow did not advance to the pinned next phase');
const nextRequest = { ...chainRequest, phase: 'review', occurrence: 2, operationKey: `${chainSelection.runId}:2` };
const nextPhase = await database.begin(tx => resolvePhaseActivity(tx, nextRequest));
const [nextAttempt] = await database.unsafe<{ inputs: { type: string; revisionId: string }[] }>(`select input_revisions as inputs from bp_action_attempts
  where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt=1`, [chainProject.id, chainSelection.runId, nextPhase.occurrenceId]);
if (nextPhase.actionId !== 'review' || nextAttempt.inputs[0]?.revisionId !== chainOutput.revisionId) throw Error('the next phase did not pin the accepted input revision');
await database.unsafe(`insert into bp_artifact_revisions(project_id,artifact_id,id,digest,payload,created_by,created_at)
  select project_id,artifact_id,'newer-revision',digest,payload,created_by,created_at+interval '1 second'
  from bp_artifact_revisions where project_id=$1 and artifact_id=$2 and id=$3`, [chainProject.id, chainOutput.artifactId, chainOutput.revisionId]);
let staleInputRejected = false;
try { await database.begin(tx => resolvePhaseActivity(tx, nextRequest)); } catch (error: any) { staleInputRejected = error.code === 'workflow_input_stale'; }
if (!staleInputRejected) throw Error('the next specialist accepted an outdated input revision');
const executorSelection = await saveWorkflowSelection(serviceModule, actor, serviceProject.id, selection, 'executor-work', schema);
await database.unsafe("update bp_workflow_runs set state='Running',revision=revision+1 where project_id=$1 and id=$2", [serviceProject.id, executorSelection.runId]);
await database.unsafe("update bp_dispatch_intents set state='Dispatched' where project_id=$1 and run_id=$2", [serviceProject.id, executorSelection.runId]);
const [executorRun] = await database.unsafe<{ planDigest: string }>('select plan_digest as "planDigest" from bp_workflow_runs where project_id=$1 and id=$2', [serviceProject.id, executorSelection.runId]);
const executorRequest = { installationId: phaseRequest.installationId, projectId: serviceProject.id, runId: executorSelection.runId as string,
  planDigest: executorRun.planDigest, phase: 'clarify', occurrence: 1, operationKey: `${executorSelection.runId}:1` };
let specialistTurns = 0;
const executor = createPhaseExecutor(serviceModule, async turn => {
  specialistTurns++;
  if (turn.agentId !== 'lead' || turn.ownerUserId !== actor.id) throw Error('wrong specialist identity');
  if (turn.projectMcp.grants.length) throw Error('unconfigured MCP access was exposed to the phase');
  const output = JSON.parse(await turn.tools[0].execute({ type: 'service-request', payload: { status: 'ready' } }));
  return { replyText: JSON.stringify({ status: 'succeeded', outputs: [{ type: 'service-request', revisionId: output.revisionId }], evidence: { confirmed: output.revisionId } }) };
});
const executorOutcome = await executor.execute(executorRequest);
const executorReplay = await executor.execute(executorRequest);
if (executorOutcome.kind !== 'complete' || JSON.stringify(executorOutcome) !== JSON.stringify(executorReplay) || specialistTurns !== 1) throw Error('specialist execution did not complete exactly once');

if (process.env.LIVE_WORKFLOW_MODEL && !process.env.LIVE_SKIP_PHASE) {
  const { runLiveWorkflowTurn } = await import('/app/server/live-workflow-turn.ts');
  const liveSelection = await saveWorkflowSelection(serviceModule, actor, serviceProject.id, {
    ...selection, request: 'Record a service request as ready. All necessary details are available.' }, 'live-executor-work', schema);
  await database.unsafe("update bp_workflow_runs set state='Running',revision=revision+1 where project_id=$1 and id=$2", [serviceProject.id,liveSelection.runId]);
  await database.unsafe("update bp_dispatch_intents set state='Dispatched' where project_id=$1 and run_id=$2", [serviceProject.id,liveSelection.runId]);
  const [liveRun] = await database.unsafe<{ planDigest: string }>('select plan_digest as "planDigest" from bp_workflow_runs where project_id=$1 and id=$2', [serviceProject.id,liveSelection.runId]);
  const liveRequest = { ...executorRequest, runId: liveSelection.runId as string, planDigest: liveRun.planDigest, operationKey: `${liveSelection.runId}:1` };
  const liveOutcome = await createPhaseExecutor(serviceModule, runLiveWorkflowTurn).execute(liveRequest);
  if (liveOutcome.kind !== 'complete') throw Error(`Live model phase did not complete: ${JSON.stringify(liveOutcome)}`);
  console.log('Live model completed a persisted, validated project phase.');
}
const serviceView = await readChatProjection(serviceModule, actor, serviceProject.id, executorSelection.itemId, executorSelection.runId, 'service-view');
if (serviceView.role !== 'team-lead' || serviceView.qaProgress.length !== 0 || !serviceView.records.some(record => record.type === 'service-request' && record.fields.status === 'ready')) throw Error('a different blueprint did not project its configured role fields');
const retryDefinition = structuredClone(serviceDefinition);
retryDefinition.version = '1.0.50';
retryDefinition.business.actions[0].results.push({ status: 'failed', requiredOutputTypes: [], requiredEvidence: [] });
retryDefinition.business.actions[0].results.push({ status: 'blocked', requiredOutputTypes: [], requiredEvidence: [] });
retryDefinition.business.actions[0].retry = { maxAttempts: 3, delaySeconds: 2 };
await serviceModule.publish(actor, retryDefinition);
const retryWorkflowProject = await serviceProjects.create(actor, { name: 'safe retries', blueprintVersion: '1.0.50' }, 'safe-retry-project');
await database.unsafe("update bp_projects set state='Operational' where id=$1", [retryWorkflowProject.id]);
await database.unsafe("insert into bp_readiness(project_id,assignment_id,assignment_revision,input_digest,status,evidence) select project_id,id,revision,'fixture','Ready','{}'::jsonb from bp_assignments where project_id=$1", [retryWorkflowProject.id]);
async function createRetryFixture(key: string) {
  const selected = await saveWorkflowSelection(serviceModule, actor, retryWorkflowProject.id, { ...selection, channelId: `channel-${retryWorkflowProject.id}` }, key, schema);
  if (selected.status !== 'saved') throw Error('Retry fixture did not save its plan');
  await database.unsafe("update bp_workflow_runs set state='Running',revision=revision+1 where project_id=$1 and id=$2", [retryWorkflowProject.id,selected.runId]);
  await database.unsafe("update bp_dispatch_intents set state='Dispatched' where project_id=$1 and run_id=$2", [retryWorkflowProject.id,selected.runId]);
  const [run] = await database.unsafe<{ planDigest: string }>('select plan_digest as "planDigest" from bp_workflow_runs where project_id=$1 and id=$2', [retryWorkflowProject.id,selected.runId]);
  return { installationId: retryWorkflowProject.installationId, projectId: retryWorkflowProject.id, runId: selected.runId as string,
    planDigest: run.planDigest, phase: 'clarify', occurrence: 1, operationKey: `${selected.runId}:1` };
}
const retryRequest = await createRetryFixture('safe-retry');
let retryTurns = 0;
const retryExecutor = createPhaseExecutor(serviceModule, async turn => {
  retryTurns++;
  if (retryTurns < 3) return { replyText: JSON.stringify({ status: 'failed', reason: 'Temporary service failure.', outputs: [], evidence: {} }) };
  const output = JSON.parse(await turn.tools[0].execute({ type: 'service-request', payload: { status: 'ready' } }));
  return { replyText: JSON.stringify({ status: 'succeeded', outputs: [{ type: 'service-request', revisionId: output.revisionId }], evidence: { confirmed: output.revisionId } }) };
});
const retryFirst = await retryExecutor.execute(retryRequest);
const retryFirstReplay = await retryExecutor.execute(retryRequest);
if (retryFirst.kind !== 'advance' || retryFirst.nextPhase !== 'clarify' || retryFirst.delaySeconds !== 2 || JSON.stringify(retryFirstReplay) !== JSON.stringify(retryFirst) || retryTurns !== 1) throw Error('The first safe retry was not persisted exactly once');
const retrySecondRequest = { ...retryRequest, occurrence: 2, operationKey: `${retryRequest.runId}:2` };
const retrySecond = await retryExecutor.execute(retrySecondRequest);
if (retrySecond.kind !== 'advance' || retrySecond.delaySeconds !== 2 || retryTurns !== 2) throw Error('The second safe retry did not honor its policy');
const retryThird = await retryExecutor.execute({ ...retryRequest, occurrence: 3, operationKey: `${retryRequest.runId}:3` });
const retryLineage = await database.unsafe<{ attempt: number }>('select attempt_number as attempt from bp_phase_retry_lineage where project_id=$1 and run_id=$2 order by attempt_number', [retryWorkflowProject.id,retryRequest.runId]);
if (retryThird.kind !== 'complete' || retryTurns !== 3 || retryLineage.map(item => item.attempt).join(',') !== '2,3') throw Error('Safe retries did not preserve their lineage and complete');
const [retryReason] = await database.unsafe<{ reason: string }>("select a.reason from bp_action_attempts a join bp_phase_occurrences o on (o.project_id,o.run_id,o.id)=(a.project_id,a.run_id,a.occurrence_id) where a.project_id=$1 and a.run_id=$2 and o.occurrence=1", [retryWorkflowProject.id,retryRequest.runId]);
if (retryReason.reason !== 'Temporary service failure.') throw Error('Safe retry lost the specialist failure reason');
await database.unsafe("insert into users values ('retry-viewer')");
await database.unsafe("insert into bp_memberships(project_id,user_id,permissions) values($1,'retry-viewer',array['read'])", [retryWorkflowProject.id]);
await database.unsafe("insert into channel_memberships(channel_id,user_id) values($1,'retry-viewer')", [`channel-${retryWorkflowProject.id}`]);
const [retryItem] = await database.unsafe<{ id: string }>('select work_item_id as id from bp_workflow_runs where project_id=$1 and id=$2', [retryWorkflowProject.id,retryRequest.runId]);
const retryOwnerRoutes = createProductRoutes(serviceModule, async (context: any, next: any) => { context.set('actor', actor); await next(); }, {} as any);
const retryOwner = await retryOwnerRoutes.request(`/${retryWorkflowProject.id}/work-items/${retryItem.id}`);
if (!(await retryOwner.json() as any).workItem.runs.some((run: any) => run.attempts.some((attempt: any) => attempt.reason === 'Temporary service failure.' && attempt.retryNumber === 1) && run.attempts.some((attempt: any) => attempt.retryNumber === 3))) throw Error('The requesting owner could not see the failed-attempt reason and retry history');
const retryViewerRoutes = createProductRoutes(serviceModule, async (context: any, next: any) => { context.set('actor', { id: 'retry-viewer', role: 'user' }); await next(); }, {} as any);
const retryViewer = await retryViewerRoutes.request(`/${retryWorkflowProject.id}/work-items/${retryItem.id}`);
if ((await retryViewer.json() as any).workItem.runs.some((run: any) => run.attempts.some((attempt: any) => attempt.reason === 'Temporary service failure.'))) throw Error('A collaborator saw another requester’s potentially private specialist reason');
const exhaustedRequest = await createRetryFixture('exhausted-retry');
let exhaustedTurns = 0;
const exhaustedExecutor = createPhaseExecutor(serviceModule, async () => { exhaustedTurns++; return { replyText: JSON.stringify({ status: 'failed', outputs: [], evidence: {} }) }; });
for (let occurrence = 1; occurrence <= 3; occurrence++) {
  const outcome = await exhaustedExecutor.execute({ ...exhaustedRequest, occurrence, operationKey: `${exhaustedRequest.runId}:${occurrence}` });
  if (occurrence < 3 ? outcome.kind !== 'advance' : outcome.kind !== 'blocked') throw Error(`Retry budget produced an invalid outcome: ${JSON.stringify(outcome)}`);
}
if (exhaustedTurns !== 3) throw Error('Retry budget did not stop the specialist');
const blockedRequest = await createRetryFixture('blocked-specialist');
let blockedTurns = 0;
const blockedExecutor = createPhaseExecutor(serviceModule, async () => { blockedTurns++; return { replyText: JSON.stringify({ status: 'blocked', reason: 'Required service is unavailable.', outputs: [], evidence: {} }) }; });
const blockedResult = await blockedExecutor.execute(blockedRequest);
const blockedReplay = await blockedExecutor.execute(blockedRequest);
if (blockedResult.kind !== 'blocked' || blockedResult.reason !== 'Required service is unavailable.' || JSON.stringify(blockedReplay) !== JSON.stringify(blockedResult) || blockedTurns !== 1) throw Error('A blocked specialist did not stop the workflow with its reason');
const unsafeRetryRequest = await createRetryFixture('unsafe-retry');
let unsafeRetryTurns = 0;
const unsafeRetryExecutor = createPhaseExecutor(serviceModule, async turn => {
  unsafeRetryTurns++;
  await turn.tools[0].execute({ type: 'service-request', payload: { status: 'ready' } });
  return { replyText: JSON.stringify({ status: 'failed', outputs: [], evidence: {} }) };
});
const unsafeRetry = await unsafeRetryExecutor.execute(unsafeRetryRequest);
const unsafeRetryReplay = await unsafeRetryExecutor.execute(unsafeRetryRequest);
const [unsafeRetryOccurrences] = await database.unsafe<{ count: number }>('select count(*)::int as count from bp_phase_occurrences where project_id=$1 and run_id=$2', [retryWorkflowProject.id,unsafeRetryRequest.runId]);
if (unsafeRetry.kind !== 'uncertain' || unsafeRetryReplay.kind !== 'uncertain' || unsafeRetryTurns !== 1 || unsafeRetryOccurrences.count !== 1) throw Error('A failed turn with a saved output was repeated');
const reservedRetryRequest = await createRetryFixture('reserved-retry');
let reservedRetryTurns = 0;
const reservedRetryExecutor = createPhaseExecutor(serviceModule, async () => {
  reservedRetryTurns++;
  await database.unsafe(`insert into bp_phase_workspace_grants(project_id,run_id,occurrence_id,tool_key)
    select project_id,run_id,id,'test-runner' from bp_phase_occurrences where project_id=$1 and run_id=$2 and occurrence=1`, [retryWorkflowProject.id,reservedRetryRequest.runId]);
  return { replyText: JSON.stringify({ status: 'failed', outputs: [], evidence: {} }) };
});
const reservedRetry = await reservedRetryExecutor.execute(reservedRetryRequest);
const reservedRetryReplay = await reservedRetryExecutor.execute(reservedRetryRequest);
const [reservedRetryOccurrences] = await database.unsafe<{ count: number }>('select count(*)::int as count from bp_phase_occurrences where project_id=$1 and run_id=$2', [retryWorkflowProject.id,reservedRetryRequest.runId]);
if (reservedRetry.kind !== 'uncertain' || reservedRetryReplay.kind !== 'uncertain' || reservedRetryTurns !== 1 || reservedRetryOccurrences.count !== 1) throw Error('A failed turn with a reserved workspace action was repeated');
const decisionDefinition = structuredClone(serviceDefinition);
decisionDefinition.version = '1.0.3';
decisionDefinition.business.workflows[0].transitions = [
  { from: 'clarify', to: 'done', when: { status: 'succeeded', decision: 'accept' } },
  { from: 'clarify', to: 'done', when: { status: 'succeeded', decision: 'defer' } },
];
await serviceModule.publish(actor, decisionDefinition);
const decisionProject = await serviceProjects.create(actor, { name: 'decision', blueprintVersion: '1.0.3' }, 'decision-project');
await database.unsafe("update bp_projects set state='Operational' where id=$1", [decisionProject.id]);
await database.unsafe("insert into bp_readiness(project_id,assignment_id,assignment_revision,input_digest,status,evidence) select project_id,id,revision,'fixture','Ready','{}'::jsonb from bp_assignments where project_id=$1", [decisionProject.id]);
const decisionSelection = await saveWorkflowSelection(serviceModule, actor, decisionProject.id, { ...selection, channelId: `channel-${decisionProject.id}` }, 'decision-work', schema);
await database.unsafe("update bp_workflow_runs set state='Running',revision=revision+1 where project_id=$1 and id=$2", [decisionProject.id, decisionSelection.runId]);
await database.unsafe("update bp_dispatch_intents set state='Dispatched' where project_id=$1 and run_id=$2", [decisionProject.id, decisionSelection.runId]);
const [decisionRun] = await database.unsafe<{ planDigest: string }>('select plan_digest as "planDigest" from bp_workflow_runs where project_id=$1 and id=$2', [decisionProject.id, decisionSelection.runId]);
const decisionRequest = { ...executorRequest, projectId: decisionProject.id, runId: decisionSelection.runId as string, planDigest: decisionRun.planDigest, operationKey: `${decisionSelection.runId}:1` };
let decisionTurns = 0;
const decisionExecutor = createPhaseExecutor(serviceModule, async turn => {
  decisionTurns++;
  const output = JSON.parse(await turn.tools[0].execute({ type: 'service-request', payload: { status: 'ready' } }));
  return { replyText: JSON.stringify({ status: 'succeeded', outputs: [{ type: 'service-request', revisionId: output.revisionId }], evidence: { confirmed: output.revisionId } }) };
});
const waiting = await decisionExecutor.execute(decisionRequest);
const waitingReconciled = await decisionExecutor.reconcile(decisionRequest);
if (waiting.kind !== 'wait' || waitingReconciled.kind !== 'wait' || waiting.decisionId !== waitingReconciled.decisionId || decisionTurns !== 1) throw Error('validated result did not retain its pending decision');
let invalidDecisionRejected = false;
try { await answerWorkflowDecision(serviceModule, actor, decisionProject.id, decisionSelection.itemId, decisionSelection.runId, waiting.decisionId, 'invented'); } catch (error: any) { invalidDecisionRejected = error.code === 'invalid_decision'; }
if (!invalidDecisionRejected) throw Error('undeclared decision choice was accepted');
await database.unsafe("insert into users values ('decision-outsider')");
await database.unsafe("insert into bp_memberships(project_id,user_id,permissions) values ($1,'decision-outsider',array['read','work'])", [decisionProject.id]);
let decisionAccessRejected = false;
try { await answerWorkflowDecision(serviceModule, { id: 'decision-outsider', role: 'user' }, decisionProject.id, decisionSelection.itemId, decisionSelection.runId, waiting.decisionId, 'accept'); } catch (error: any) { decisionAccessRejected = error.code === 'decision_not_found'; }
if (!decisionAccessRejected) throw Error('decision accepted an actor outside the originating conversation');
await database.unsafe("insert into users values ('decision-limited')");
await database.unsafe("insert into bp_memberships(project_id,user_id,permissions) values ($1,'decision-limited',array['read','work'])", [decisionProject.id]);
await database.unsafe("insert into channel_memberships(channel_id,user_id) values ($1,'decision-limited')", [`channel-${decisionProject.id}`]);
await database.unsafe(`update bp_artifacts a set allowed_user_ids=array['owner'] from bp_artifact_revisions ar,bp_phase_results x
  where a.project_id=$1 and ar.project_id=a.project_id and ar.artifact_id=a.id and x.project_id=a.project_id and x.run_id=$2 and ar.id=x.result->'outputs'->0->>'revisionId'`, [decisionProject.id,decisionSelection.runId]);
const limitedDecisionRoutes = createProductRoutes(serviceModule, async (context: any, next: any) => { context.set('actor', { id: 'decision-limited', role: 'user' }); await next(); }, {} as any);
const limitedDecisionView = await limitedDecisionRoutes.request(`/${decisionProject.id}/work-items/${decisionSelection.itemId}`);
if ((await limitedDecisionView.json() as any).workItem.runs.some((run: any) => run.decisions.length)) throw Error('a decision exposed a restricted result to a conversation member');
let restrictedDecisionRejected = false;
try { await answerWorkflowDecision(serviceModule, { id: 'decision-limited', role: 'user' }, decisionProject.id, decisionSelection.itemId, decisionSelection.runId, waiting.decisionId, 'accept'); } catch (error: any) { restrictedDecisionRejected = error.code === 'decision_not_found'; }
if (!restrictedDecisionRejected) throw Error('a conversation member answered a decision based on a restricted result');
const decisionRoutes = createProductRoutes(serviceModule, async (context: any, next: any) => { context.set('actor', actor); await next(); }, {} as any);
const decisionWorkList = await decisionRoutes.request(`/${decisionProject.id}/work-items`);
if (!(await decisionWorkList.json() as any).workItems.some((item: any) => item.id === decisionSelection.itemId)) throw Error('authorized work item was absent from the project list');
const outsiderDecisionRoutes = createProductRoutes(serviceModule, async (context: any, next: any) => { context.set('actor', { id: 'decision-outsider', role: 'user' }); await next(); }, {} as any);
const outsiderWorkList = await outsiderDecisionRoutes.request(`/${decisionProject.id}/work-items`);
if ((await outsiderWorkList.json() as any).workItems.length) throw Error('work list leaked an inaccessible conversation');
const decisionWork = await decisionRoutes.request(`/${decisionProject.id}/work-items/${decisionSelection.itemId}`);
const decisionWorkPayload = await decisionWork.json() as any;
if (!decisionWorkPayload.workItem.runs[0].decisions.some((item: any) => item.id === waiting.decisionId && item.choices.includes('accept'))) throw Error('work view did not show the permitted decision options');
const decisionResponse = await decisionRoutes.request(`/${decisionProject.id}/work-items/${decisionSelection.itemId}/runs/${decisionSelection.runId}/decisions/${waiting.decisionId}`,
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'accept' }) });
if (decisionResponse.status !== 200) throw Error('authorized decision route failed');
await answerWorkflowDecision(serviceModule, actor, decisionProject.id, decisionSelection.itemId, decisionSelection.runId, waiting.decisionId, 'accept');
let changedDecisionRejected = false;
try { await answerWorkflowDecision(serviceModule, actor, decisionProject.id, decisionSelection.itemId, decisionSelection.runId, waiting.decisionId, 'defer'); } catch (error: any) { changedDecisionRejected = error.code === 'decision_conflict'; }
if (!changedDecisionRejected) throw Error('answered decision was changed');
const decisionEngine = Bun.serve({ port: 0, async fetch(request) { const body = await request.json() as any; return Response.json({ accepted: body.decisionId === waiting.decisionId && body.value === 'accept' }); } });
const priorEngineUrl = process.env.WORKFLOW_ENGINE_URL;
process.env.WORKFLOW_ENGINE_URL = `http://127.0.0.1:${decisionEngine.port}`;
await database.unsafe('delete from channel_memberships where channel_id=$1 and user_id=$2', [`channel-${decisionProject.id}`, actor.id]);
if (await dispatchPendingDecision(serviceModule)) throw Error('decision was sent after conversation access was revoked');
await database.unsafe('insert into channel_memberships(channel_id,user_id) values($1,$2)', [`channel-${decisionProject.id}`, actor.id]);
if (!await dispatchPendingDecision(serviceModule) || await dispatchPendingDecision(serviceModule)) throw Error('decision signal was not dispatched once');
process.env.WORKFLOW_ENGINE_URL = priorEngineUrl; decisionEngine.stop();
await database.unsafe('delete from channel_memberships where channel_id=$1 and user_id=$2', [`channel-${decisionProject.id}`, actor.id]);
let revokedDecisionResumeRejected = false;
try { await decisionExecutor.execute({ ...decisionRequest, decision: { id: waiting.decisionId, value: 'accept' } }); } catch { revokedDecisionResumeRejected = true; }
if (!revokedDecisionResumeRejected) throw Error('decision resumed after conversation access was revoked');
await database.unsafe('insert into channel_memberships(channel_id,user_id) values($1,$2)', [`channel-${decisionProject.id}`, actor.id]);
const resumedDecision = await decisionExecutor.execute({ ...decisionRequest, decision: { id: waiting.decisionId, value: 'accept' } });
const resumedDecisionReplay = await decisionExecutor.execute({ ...decisionRequest, decision: { id: waiting.decisionId, value: 'accept' } });
if (resumedDecision.kind !== 'complete' || JSON.stringify(resumedDecision) !== JSON.stringify(resumedDecisionReplay) || decisionTurns !== 1) throw Error('decision did not resume the original phase exactly once');
let wrongReplayRejected = false;
try { await decisionExecutor.execute({ ...decisionRequest, decision: { id: waiting.decisionId, value: 'defer' } }); } catch (error: any) { wrongReplayRejected = error.code === 'workflow_decision_unavailable'; }
if (!wrongReplayRejected) throw Error('completed decision accepted a conflicting replay');
const lostWaitSelection = await saveWorkflowSelection(serviceModule, actor, decisionProject.id, { ...selection, channelId: `channel-${decisionProject.id}` }, 'lost-wait-work', schema);
await database.unsafe("update bp_workflow_runs set state='Running',revision=revision+1 where project_id=$1 and id=$2", [decisionProject.id, lostWaitSelection.runId]);
await database.unsafe("update bp_dispatch_intents set state='Dispatched' where project_id=$1 and run_id=$2", [decisionProject.id, lostWaitSelection.runId]);
const [lostWaitRun] = await database.unsafe<{ planDigest: string }>('select plan_digest as "planDigest" from bp_workflow_runs where project_id=$1 and id=$2', [decisionProject.id, lostWaitSelection.runId]);
const lostWaitRequest = { ...decisionRequest, runId: lostWaitSelection.runId as string, planDigest: lostWaitRun.planDigest, operationKey: `${lostWaitSelection.runId}:1` };
const lostWait = await decisionExecutor.execute(lostWaitRequest);
if (lostWait.kind !== 'wait') throw Error('second workflow did not wait');
await answerWorkflowDecision(serviceModule, actor, decisionProject.id, lostWaitSelection.itemId, lostWaitSelection.runId, lostWait.decisionId, 'accept');
const reconciledAnswer = await decisionExecutor.reconcile(lostWaitRequest);
if (reconciledAnswer.kind !== 'complete' || decisionTurns !== 2) throw Error('committed answer was not reconciled after a lost wait response');
const previouslyConfiguredEngine = process.env.WORKFLOW_ENGINE_URL;
process.env.WORKFLOW_ENGINE_URL = 'http://127.0.0.1:1';
if (!await dispatchPendingDecision(serviceModule)) throw Error('completed decision signal was not reconciled locally');
process.env.WORKFLOW_ENGINE_URL = previouslyConfiguredEngine;
const staleWaitSelection = await saveWorkflowSelection(serviceModule, actor, decisionProject.id, { ...selection, channelId: `channel-${decisionProject.id}` }, 'stale-wait-work', schema);
await database.unsafe("update bp_workflow_runs set state='Running',revision=revision+1 where project_id=$1 and id=$2", [decisionProject.id, staleWaitSelection.runId]);
await database.unsafe("update bp_dispatch_intents set state='Dispatched' where project_id=$1 and run_id=$2", [decisionProject.id, staleWaitSelection.runId]);
const [staleWaitRun] = await database.unsafe<{ planDigest: string }>('select plan_digest as "planDigest" from bp_workflow_runs where project_id=$1 and id=$2', [decisionProject.id, staleWaitSelection.runId]);
const staleWaitRequest = { ...decisionRequest, runId: staleWaitSelection.runId as string, planDigest: staleWaitRun.planDigest, operationKey: `${staleWaitSelection.runId}:1` };
const staleWait = await decisionExecutor.execute(staleWaitRequest);
if (staleWait.kind !== 'wait') throw Error('stale result fixture did not wait');
await answerWorkflowDecision(serviceModule, actor, decisionProject.id, staleWaitSelection.itemId, staleWaitSelection.runId, staleWait.decisionId, 'accept');
await database.unsafe(`insert into bp_artifact_revisions(project_id,artifact_id,id,digest,payload,created_by,created_at)
  select r.project_id,r.artifact_id,'newer-decision-output',r.digest,r.payload,r.created_by,r.created_at+interval '1 second'
  from bp_phase_results x join bp_artifact_revisions r on r.project_id=x.project_id and r.id=x.result->'outputs'->0->>'revisionId'
  where x.project_id=$1 and x.run_id=$2`, [decisionProject.id, staleWaitSelection.runId]);
let staleDecisionOutputRejected = false;
try { await decisionExecutor.reconcile(staleWaitRequest); } catch (error: any) { staleDecisionOutputRejected = error.code === 'result_unavailable'; }
if (!staleDecisionOutputRejected) throw Error('decision resumed with an outdated output revision');
const clarificationDefinition = structuredClone(serviceDefinition);
clarificationDefinition.version = '1.0.4';
clarificationDefinition.business.actions[0].results.push({ status: 'needs-input', requiredOutputTypes: [], requiredEvidence: [] });
await serviceModule.publish(actor, clarificationDefinition);
const clarificationProject = await serviceProjects.create(actor, { name: 'clarification', blueprintVersion: '1.0.4' }, 'clarification-project');
await database.unsafe("update bp_projects set state='Operational' where id=$1", [clarificationProject.id]);
await database.unsafe("insert into bp_readiness(project_id,assignment_id,assignment_revision,input_digest,status,evidence) select project_id,id,revision,'fixture','Ready','{}'::jsonb from bp_assignments where project_id=$1", [clarificationProject.id]);
const clarificationSelection = await saveWorkflowSelection(serviceModule, actor, clarificationProject.id, { ...selection, channelId: `channel-${clarificationProject.id}` }, 'clarification-work', schema);
await database.unsafe("update bp_workflow_runs set state='Running',revision=revision+1 where project_id=$1 and id=$2", [clarificationProject.id, clarificationSelection.runId]);
await database.unsafe("update bp_dispatch_intents set state='Dispatched' where project_id=$1 and run_id=$2", [clarificationProject.id, clarificationSelection.runId]);
const [clarificationRun] = await database.unsafe<{ planDigest: string }>('select plan_digest as "planDigest" from bp_workflow_runs where project_id=$1 and id=$2', [clarificationProject.id, clarificationSelection.runId]);
const clarificationRequest = { ...executorRequest, projectId: clarificationProject.id, runId: clarificationSelection.runId as string, planDigest: clarificationRun.planDigest, operationKey: `${clarificationSelection.runId}:1` };
let clarificationTurns = 0;
const clarificationExecutor = createPhaseExecutor(serviceModule, async turn => {
  clarificationTurns++;
  if (clarificationTurns === 1) return { replyText: JSON.stringify({ status: 'needs-input', question: 'Who is the target audience?', outputs: [], evidence: {} }) };
  if (!turn.instruction.includes('Small business owners')) throw Error('specialist did not receive the authorized clarification');
  if (clarificationTurns === 2) return { replyText: JSON.stringify({ status: 'needs-input', question: 'Which launch region?', outputs: [], evidence: {} }) };
  if (!turn.instruction.includes('North America')) throw Error('specialist did not receive the second clarification');
  const output = JSON.parse(await turn.tools[0].execute({ type: 'service-request', payload: { status: 'ready' } }));
  return { replyText: JSON.stringify({ status: 'succeeded', outputs: [{ type: 'service-request', revisionId: output.revisionId }], evidence: { confirmed: output.revisionId } }) };
});
const clarificationWait = await clarificationExecutor.execute(clarificationRequest);
if (clarificationWait.kind !== 'wait' || clarificationWait.question !== 'Who is the target audience?' || clarificationTurns !== 1) throw Error('specialist clarification was not persisted');
const clarificationRoutes = createProductRoutes(serviceModule, async (context: any, next: any) => { context.set('actor', actor); await next(); }, {} as any);
const clarificationView = await clarificationRoutes.request(`/${clarificationProject.id}/work-items/${clarificationSelection.itemId}`);
if (!(await clarificationView.json() as any).workItem.runs.some((run: any) => run.decisions.some((item: any) => item.id === clarificationWait.decisionId && item.kind === 'clarification'))) throw Error('the clarification was not shown in the work view');
const clarificationResponse = await clarificationRoutes.request(`/${clarificationProject.id}/work-items/${clarificationSelection.itemId}/runs/${clarificationSelection.runId}/decisions/${clarificationWait.decisionId}`,
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'Small business owners' }) });
if (clarificationResponse.status !== 200) throw Error('free-text clarification was not accepted');
const lostClarification = await clarificationExecutor.reconcile(clarificationRequest);
if (lostClarification.kind !== 'not-started') throw Error('answered clarification did not create a recoverable continuation');
const secondQuestion = await clarificationExecutor.execute(clarificationRequest);
if (secondQuestion.kind !== 'wait' || secondQuestion.question !== 'Which launch region?' || clarificationTurns !== 2) throw Error('specialist could not ask a second clarification');
await answerWorkflowDecision(serviceModule, actor, clarificationProject.id, clarificationSelection.itemId, clarificationSelection.runId, secondQuestion.decisionId, 'North America');
const clarifiedOutcome = await clarificationExecutor.execute({ ...clarificationRequest, decision: { id: secondQuestion.decisionId, value: 'North America' } });
if (clarifiedOutcome.kind !== 'complete' || clarificationTurns !== 3) throw Error('specialist did not continue after clarification');
const clarifiedReplay = await clarificationExecutor.execute({ ...clarificationRequest, decision: { id: clarificationWait.decisionId, value: 'Small business owners' } });
if (clarifiedReplay.kind !== 'complete' || clarificationTurns !== 3) throw Error('clarification replay repeated the specialist');
const [clarificationAttempts] = await database.unsafe<{ count: number; keys: number }>(`select count(*)::int as count,count(distinct d.operation_key)::int as keys from bp_action_attempts a
  join bp_dispatch_intents d on (d.project_id,d.run_id,d.occurrence_id,d.attempt)=(a.project_id,a.run_id,a.occurrence_id,a.attempt)
  where a.project_id=$1 and a.run_id=$2`, [clarificationProject.id,clarificationSelection.runId]);
if (clarificationAttempts.count !== 3 || clarificationAttempts.keys !== 1) throw Error('clarification did not preserve the occurrence operation key');
const unsafeClarificationSelection = await saveWorkflowSelection(serviceModule, actor, clarificationProject.id, { ...selection, channelId: `channel-${clarificationProject.id}` }, 'unsafe-clarification-work', schema);
await database.unsafe("update bp_workflow_runs set state='Running',revision=revision+1 where project_id=$1 and id=$2", [clarificationProject.id, unsafeClarificationSelection.runId]);
await database.unsafe("update bp_dispatch_intents set state='Dispatched' where project_id=$1 and run_id=$2", [clarificationProject.id, unsafeClarificationSelection.runId]);
const [unsafeClarificationRun] = await database.unsafe<{ planDigest: string }>('select plan_digest as "planDigest" from bp_workflow_runs where project_id=$1 and id=$2', [clarificationProject.id, unsafeClarificationSelection.runId]);
const unsafeClarificationRequest = { ...clarificationRequest, runId: unsafeClarificationSelection.runId as string, planDigest: unsafeClarificationRun.planDigest, operationKey: `${unsafeClarificationSelection.runId}:1` };
const unsafeClarificationExecutor = createPhaseExecutor(serviceModule, async turn => {
  await turn.tools[0].execute({ type: 'service-request', payload: { status: 'ready' } });
  return { replyText: JSON.stringify({ status: 'needs-input', question: 'Which audience?', outputs: [], evidence: {} }) };
});
const unsafeClarification = await unsafeClarificationExecutor.execute(unsafeClarificationRequest);
if (unsafeClarification.kind !== 'uncertain' || !(unsafeClarification.reason ?? '').includes('earlier output') || (await database.unsafe('select 1 from bp_phase_clarifications where project_id=$1 and run_id=$2', [clarificationProject.id,unsafeClarificationSelection.runId])).length) throw Error('clarification incorrectly replayed a phase with an earlier output');
const invalidSelection = await saveWorkflowSelection(serviceModule, actor, serviceProject.id, selection, 'invalid-executor-work', schema);
await database.unsafe("update bp_workflow_runs set state='Running',revision=revision+1 where project_id=$1 and id=$2", [serviceProject.id, invalidSelection.runId]);
await database.unsafe("update bp_dispatch_intents set state='Dispatched' where project_id=$1 and run_id=$2", [serviceProject.id, invalidSelection.runId]);
const [invalidRun] = await database.unsafe<{ planDigest: string }>('select plan_digest as "planDigest" from bp_workflow_runs where project_id=$1 and id=$2', [serviceProject.id, invalidSelection.runId]);
const invalidRequest = { ...executorRequest, runId: invalidSelection.runId as string, planDigest: invalidRun.planDigest, operationKey: `${invalidSelection.runId}:1` };
const invalidExecutor = createPhaseExecutor(serviceModule, async () => ({ replyText: JSON.stringify({ status: 'succeeded', outputs: [], evidence: {} }) }));
if ((await invalidExecutor.execute(invalidRequest)).kind !== 'uncertain') throw Error('invalid specialist result advanced');
const [rejection] = await database.unsafe<{ count: number }>('select count(*)::int as count from bp_phase_result_rejections where project_id=$1 and run_id=$2', [serviceProject.id, invalidSelection.runId]);
if (rejection.count !== 1) throw Error('invalid specialist result did not retain rejection history');
let rejectionImmutable = false;
try { await database.unsafe('delete from bp_phase_result_rejections where project_id=$1 and run_id=$2', [serviceProject.id, invalidSelection.runId]); } catch { rejectionImmutable = true; }
if (!rejectionImmutable) throw Error('specialist rejection history was mutable');
const workspaceSelection = await saveWorkflowSelection(serviceModule, actor, chainProject.id, { ...selection, channelId: `channel-${chainProject.id}` }, 'workspace-executor-work', schema);
await database.unsafe("update bp_workflow_runs set state='Running',revision=revision+1 where project_id=$1 and id=$2", [chainProject.id, workspaceSelection.runId]);
await database.unsafe("update bp_dispatch_intents set state='Dispatched' where project_id=$1 and run_id=$2", [chainProject.id, workspaceSelection.runId]);
const [workspaceRun] = await database.unsafe<{ planDigest: string }>('select plan_digest as "planDigest" from bp_workflow_runs where project_id=$1 and id=$2', [chainProject.id, workspaceSelection.runId]);
const workspaceRequest = { installationId: chainRun.installationId, projectId: chainProject.id, runId: workspaceSelection.runId as string,
  planDigest: workspaceRun.planDigest, phase: 'clarify', occurrence: 1, operationKey: `${workspaceSelection.runId}:1` };
let workspaceEffects = 0, workspaceTurns = 0, failWorkspaceResponse = false;
const executorProvider = Bun.serve({ port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/run') workspaceEffects++;
  if (path === '/run' && failWorkspaceResponse) return Response.json({ error: 'response lost' }, { status: 503 });
  return Response.json(path === '/check' ? { id: 'chain-vm', ready: true, isolated: true } : { status: 'completed', exitCode: 0, stdout: 'ok', stderr: '' });
} });
const savedExecutorProvider = { url: process.env.WORKSPACE_PROVIDER_URL, token: process.env.WORKSPACE_PROVIDER_TOKEN, installation: process.env.WORKSPACE_PROVIDER_INSTALLATION_ID };
process.env.WORKSPACE_PROVIDER_URL = `http://127.0.0.1:${executorProvider.port}`; process.env.WORKSPACE_PROVIDER_TOKEN = 'fixture-token'; delete process.env.WORKSPACE_PROVIDER_INSTALLATION_ID;
const workspaceExecutor = createPhaseExecutor(serviceModule, async turn => {
  workspaceTurns++;
  const command = turn.tools.find(tool => tool.name === 'project_phase_workspace');
  if (!command || !JSON.parse(await command.execute({ tool: 'test-runner', argv: ['true'] })).evidenceId) throw Error('workspace evidence was not available to the specialist');
  const output = JSON.parse(await turn.tools[0].execute({ type: 'service-request', payload: { status: 'ready' } }));
  return { replyText: JSON.stringify({ status: 'succeeded', outputs: [{ type: 'service-request', revisionId: output.revisionId }], evidence: { confirmed: output.revisionId } }) };
});
const workspaceOutcome = await workspaceExecutor.execute(workspaceRequest);
const workspaceReplay = await workspaceExecutor.execute(workspaceRequest);
if (workspaceOutcome.kind !== 'advance' || JSON.stringify(workspaceOutcome) !== JSON.stringify(workspaceReplay) || workspaceTurns !== 1 || workspaceEffects !== 1) throw Error('workspace specialist was not executed exactly once');
const uncertainWorkspaceSelection = await saveWorkflowSelection(serviceModule, actor, chainProject.id, { ...selection, channelId: `channel-${chainProject.id}` }, 'uncertain-workspace-work', schema);
await database.unsafe("update bp_workflow_runs set state='Running',revision=revision+1 where project_id=$1 and id=$2", [chainProject.id, uncertainWorkspaceSelection.runId]);
await database.unsafe("update bp_dispatch_intents set state='Dispatched' where project_id=$1 and run_id=$2", [chainProject.id, uncertainWorkspaceSelection.runId]);
const [uncertainWorkspaceRun] = await database.unsafe<{ planDigest: string }>('select plan_digest as "planDigest" from bp_workflow_runs where project_id=$1 and id=$2', [chainProject.id, uncertainWorkspaceSelection.runId]);
const uncertainWorkspaceRequest = { ...workspaceRequest, runId: uncertainWorkspaceSelection.runId as string, planDigest: uncertainWorkspaceRun.planDigest, operationKey: `${uncertainWorkspaceSelection.runId}:1` };
failWorkspaceResponse = true;
const uncertainWorkspaceExecutor = createPhaseExecutor(serviceModule, async turn => {
  const command = turn.tools.find(tool => tool.name === 'project_phase_workspace');
  if (!command || !(await command.execute({ tool: 'test-runner', argv: ['true'] })).startsWith('Refused')) throw Error('failed provider response was not held');
  return { replyText: JSON.stringify({ status: 'needs-input', question: 'Continue?', outputs: [], evidence: {} }) };
});
const uncertainWorkspaceOutcome = await uncertainWorkspaceExecutor.execute(uncertainWorkspaceRequest);
const [reservedCommand] = await database.unsafe<{ count: number }>('select count(*)::int as count from bp_phase_workspace_commands where project_id=$1 and run_id=$2', [chainProject.id,uncertainWorkspaceSelection.runId]);
if (uncertainWorkspaceOutcome.kind !== 'uncertain' || reservedCommand.count !== 1 || workspaceEffects !== 2 ||
    (await database.unsafe('select 1 from bp_phase_clarifications where project_id=$1 and run_id=$2', [chainProject.id,uncertainWorkspaceSelection.runId])).length) throw Error('uncertain workspace operation was allowed to become a repeatable clarification');
failWorkspaceResponse = false;
executorProvider.stop();
if (savedExecutorProvider.url === undefined) delete process.env.WORKSPACE_PROVIDER_URL; else process.env.WORKSPACE_PROVIDER_URL = savedExecutorProvider.url;
if (savedExecutorProvider.token === undefined) delete process.env.WORKSPACE_PROVIDER_TOKEN; else process.env.WORKSPACE_PROVIDER_TOKEN = savedExecutorProvider.token;
if (savedExecutorProvider.installation === undefined) delete process.env.WORKSPACE_PROVIDER_INSTALLATION_ID; else process.env.WORKSPACE_PROVIDER_INSTALLATION_ID = savedExecutorProvider.installation;
if ((await database.begin(tx => reconcilePhaseActivity(tx, phaseRequest))).kind !== 'uncertain') throw Error('claimed phase was incorrectly safe to repeat');
await database.unsafe('delete from channel_memberships where channel_id=$1 and user_id=$2', [selection.channelId, actor.id]);
let revokedReconcileRejected = false;
try { await database.begin(tx => reconcilePhaseActivity(tx, phaseRequest)); } catch { revokedReconcileRejected = true; }
if (!revokedReconcileRejected) throw Error('phase reconciliation survived revoked conversation access');
await database.unsafe('insert into channel_memberships(channel_id,user_id) values($1,$2)', [selection.channelId, actor.id]);
let conflictingClaimRejected = false;
try { await database.begin(tx => claimPhaseActivity(tx, { ...phaseRequest, decision: { id: 'other', value: true } } as any)); }
catch (error: any) { conflictingClaimRejected = error.code === 'phase_conflict'; }
if (!conflictingClaimRejected) throw Error('a phase attempt accepted a changed request');
if (await dispatchPendingWorkflow(serviceModule)) throw Error('the same workflow was dispatched twice');
engine.stop();
const [serviceAssignment] = await database.unsafe<{ id: string; botId: string }>("select id,native_bot_id as \"botId\" from bp_assignments where project_id=$1 and role_key='team-lead'", [serviceProject.id]);
await database.unsafe('insert into intelligence_channel_mappings values ($1,$2,$3)', [selection.channelId, actor.id, 'native-thread']);
const nativeContext = await database.begin(tx => requireNativeBotContext(tx, actor, { actorId: actor.id, botId: 'team-lead', threadId: 'native-thread' }));
if (nativeContext.project.id !== serviceProject.id || nativeContext.channelId !== selection.channelId) throw Error('native thread did not resolve its project');
const delegationScope = { actorId: actor.id, botId: 'team-lead', threadId: 'native-thread' };
if (!(await guardProjectDelegation(serviceModule, actor, delegationScope))?.text.includes('workflow delegation')) throw Error('raw project delegation bypassed the workflow gate');
await database.unsafe("update bp_readiness set status='Blocked' where project_id=$1", [serviceProject.id]);
if (!(await guardProjectDelegation(serviceModule, actor, delegationScope))?.text.includes('readiness')) throw Error('stale readiness did not block project delegation');
await database.unsafe("update bp_readiness set status='Ready' where project_id=$1", [serviceProject.id]);
await database.unsafe("update bp_projects set state='Initializing' where id=$1", [serviceProject.id]);
if (!(await guardProjectDelegation(serviceModule, actor, delegationScope))?.text.includes('readiness')) throw Error('initializing project allowed operational delegation');
await database.unsafe("update bp_projects set state='Operational' where id=$1", [serviceProject.id]);
if (await guardProjectDelegation(serviceModule, actor, { ...delegationScope, threadId: 'nonproject-thread' }) !== null) throw Error('ordinary nonproject delegation was intercepted');
const signedCall = { name: 'project_context', args: {}, actorId: actor.id, botId: 'team-lead', run: { actorId: actor.id, botId: 'team-lead', threadId: 'native-thread' } };
const callbackToken = mintCallbackToken();
const testEncryptionKey = 'test-signing-key-01234567890123456789';
const assertion = mintRunAssertion({ ...signedCall.run, runId: 'native-run' }, testEncryptionKey);
const verifiedCall = await authoriseAgentCall({ presented: callbackToken, run: assertion, encryptionKey: testEncryptionKey,
  lookup: async hash => hash === hashCallbackToken(callbackToken) ? { id: 'team-lead' } : null });
if (!verifiedCall.ok) throw Error('native callback verification failed');
const verifiedReply = await callNativeProjectTool(serviceModule, actor, { ...signedCall, run: verifiedCall.run });
if (verifiedReply?.isError || JSON.parse(verifiedReply!.text).projectId !== serviceProject.id) throw Error('verified native callback did not resolve its project');
const forgedCall = await authoriseAgentCall({ presented: mintCallbackToken(), run: assertion, encryptionKey: testEncryptionKey, lookup: async () => null });
if (forgedCall.ok) throw Error('native callback accepted an unrecognized bot token');
const nativeToolReply = await callNativeProjectTool(serviceModule, actor, signedCall);
if (nativeToolReply?.isError || JSON.parse(nativeToolReply!.text).projectId !== serviceProject.id) throw Error('signed bot could not read its project context');
if (!(await callNativeProjectTool(serviceModule, actor, { ...signedCall, args: { projectId: 'another-project' } }))?.isError) throw Error('project context accepted a caller-selected project');
if (!(await callNativeProjectTool(serviceModule, actor, { ...signedCall, run: { ...signedCall.run, actorId: 'other' } }))?.isError) throw Error('project context accepted a mismatched signed actor');
if (!(await callNativeProjectTool(serviceModule, actor, { ...signedCall, run: { ...signedCall.run, threadId: 'unmapped-thread' } }))?.isError) throw Error('project context accepted an unmapped thread');
if (await callNativeProjectTool(serviceModule, actor, { ...signedCall, name: 'unrelated_tool' }) !== null) throw Error('project context intercepted an unrelated tool');
let botAvailable = true;
const nativeTools = await nativeProjectTools(serviceModule, actor, signedCall.run, {}, {}, async () => botAvailable);
if (nativeTools.length !== 6 || JSON.parse(await nativeTools[0].execute({})).projectId !== serviceProject.id) throw Error('built-in bot project tools were not available');
const workflowCatalog = JSON.parse(await nativeTools[4].execute({}));
if (!workflowCatalog.workflows.some((item: any) => item.id === 'service-request' && item.phases?.length && item.transitions?.length) ||
    !workflowCatalog.actions.some((item: any) => item.id === 'clarify') || !workflowCatalog.roles.some((item: any) => item.id === 'coordinator')) throw Error('Team Lead could not read workflow planning context');
const nativeWork = JSON.parse(await nativeTools[5].execute({}));
if (!nativeWork.runs.some((run: any) => run.runId === firstSelection.runId) || nativeWork.runs.some((run: any) => run.workItemId === 'item')) throw Error('Team Lead work view was not scoped to its conversation');
if (!(await callNativeProjectTool(serviceModule, actor, { ...signedCall, name: 'project_work', args: { projectId: 'other' } }))?.isError) throw Error('Team Lead work accepted a caller-selected project');
const planningCall = { name: 'project_prepare_workflow', actorId: actor.id, botId: 'team-lead', run: verifiedCall.run,
  args: { request: 'Please handle this request.', interpretation: { workflowId: 'service-request' } } };
const planned = await callNativeWorkflowTool(serviceModule, actor, planningCall);
const plannedAgain = await callNativeWorkflowTool(serviceModule, actor, planningCall);
const planReply = planned?.text ? JSON.parse(planned.text) : null;
const replayedPlanReply = plannedAgain?.text ? JSON.parse(plannedAgain.text) : null;
if (planned?.isError || planReply?.execution !== 'pending' || planReply?.message !== 'The plan is saved but has not started.' ||
    planReply?.runId !== replayedPlanReply?.runId || replayedPlanReply?.message !== 'The plan is saved but has not started.') {
  throw Error('Team Lead plan status was ambiguous or its saved-plan response was not idempotent');
}
if (process.env.LIVE_WORKFLOW_MODEL && process.env.LIVE_TEMP_PLAN) {
  const { runLiveWorkflowTurn } = await import('/app/server/live-workflow-turn.ts');
  let savedRun: string | undefined;
  const response = await runLiveWorkflowTurn({ ownerUserId: actor.id, agentId: 'team-lead',
    systemPrompt: await Bun.file('/swe-fixture/prompts/team-lead.md').text(),
    instruction: 'We need an incident investigated and resolved. Inspect project_workflows first. If the available actions cannot do this, explain the missing capability; do not substitute a clarification action and imply the incident was investigated or resolved.',
    tools: [{ name: 'project_workflows', description: 'Read published workflows, available roles, and actions.', parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => nativeTools[4].execute({}) },
    { name: 'project_prepare_workflow', description: 'Save a temporary workflow interpretation.', parameters: { type: 'object', properties: {
      request: { type: 'string' }, interpretation: { type: 'object', properties: { temporary: { type: 'object', properties: {
        workflow: { type: 'object', additionalProperties: true }, rationale: { type: 'string' }, guidance: { type: 'array', items: { type: 'string' } },
      }, required: ['workflow','rationale','guidance'], additionalProperties: false } }, required: ['temporary'], additionalProperties: false },
    }, required: ['request','interpretation'], additionalProperties: false }, execute: async (args: any) => {
      const result = await callNativeWorkflowTool(serviceModule, actor, { ...planningCall, run: { ...planningCall.run, runId: 'live-temporary-run' }, args });
      if (!result) return 'Refused.';
      if (!result.isError) savedRun = JSON.parse(result.text).runId;
      return result.text;
    } }] });
  if (!response.replyText || savedRun || !/cannot|can.t|unable|not (?:able|available)|lack|missing/i.test(response.replyText)) throw Error('Live Team Lead did not explain the missing incident capability.');
  console.log('Live Team Lead reported the missing incident capability without saving a misleading plan.');
}
if (process.env.LIVE_WORKFLOW_MODEL && !process.env.LIVE_SKIP_LEAD) {
  const { runLiveWorkflowTurn } = await import('/app/server/live-workflow-turn.ts');
  let selectedRun: string | undefined;
  const leadTurn = await runLiveWorkflowTurn({ ownerUserId: actor.id, agentId: 'team-lead',
    systemPrompt: await Bun.file('/swe-fixture/prompts/team-lead.md').text(),
    instruction: 'Please coordinate this service request. First inspect the published processes using project_workflows, then call project_prepare_workflow with my request and the matching workflow ID. Do not invent a workflow ID.',
    tools: [{ name: 'project_workflows', description: 'List the published project workflows.', parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => nativeTools[4].execute({}) },
    { name: 'project_prepare_workflow', description: 'Save the selected workflow for the request.', parameters: { type: 'object', properties: {
      request: { type: 'string' }, interpretation: { type: 'object', properties: { workflowId: { type: 'string' } }, required: ['workflowId'], additionalProperties: false },
    }, required: ['request','interpretation'], additionalProperties: false }, execute: async (args: any) => {
      const reply = await callNativeWorkflowTool(serviceModule, actor, { ...planningCall, run: { ...planningCall.run, runId: 'live-lead-run' }, args });
      if (!reply || reply.isError) throw Error('Live Team Lead planning tool refused the selection.');
      const result = JSON.parse(reply.text); selectedRun = result.runId; return reply.text;
    } }] });
  const [selected] = await database.unsafe<{ workflow: string }>('select workflow_key as workflow from bp_workflow_runs where project_id=$1 and id=$2', [serviceProject.id,selectedRun]);
  if (!leadTurn.replyText || selected?.workflow !== 'service-request') throw Error('Live Team Lead did not persist the published workflow.');
  console.log('Live Team Lead selected and saved a published project workflow.');
}
if (!(await callNativeWorkflowTool(serviceModule, actor, { ...planningCall, args: { ...planningCall.args, request: 'A different request.' } }))?.isError) throw Error('workflow planning accepted a changed retry');
await database.unsafe("update bp_memberships set permissions=array['read'] where project_id=$1 and user_id=$2", [serviceProject.id, actor.id]);
if (!(await callNativeWorkflowTool(serviceModule, actor, planningCall))?.isError) throw Error('workflow planning replay ignored revoked work permission');
await database.unsafe("update bp_memberships set permissions=array['read','manage','work','approve','feedback'] where project_id=$1 and user_id=$2", [serviceProject.id, actor.id]);
const clarification = await callNativeWorkflowTool(serviceModule, actor, { ...planningCall, run: { ...planningCall.run, runId: 'clarification-run' },
  args: { request: 'Help with a service.', interpretation: { needsClarification: 'Which service needs help?' } } });
if (clarification?.isError || JSON.parse(clarification!.text).question !== 'Which service needs help?') throw Error('Team Lead could not request workflow clarification');
if (!JSON.parse(await nativeTools[2].execute({})).artifacts.some((item: any) => item.id === 'service-artifact' && item.revisionId === 'revision')) throw Error('built-in bot could not list an authorized artifact');
if (JSON.parse(await nativeTools[3].execute({ artifactId: 'service-artifact', revisionId: 'revision' })).id !== 'revision') throw Error('built-in bot could not read an authorized artifact');
if (!(await nativeTools[3].execute({ artifactId: 'missing' })).startsWith('Refused.')) throw Error('built-in bot read an unknown artifact');
if (!(await nativeTools[3].execute({ artifactId: 'service-artifact', projectId: 'another-project' })).startsWith('Refused.')) throw Error('built-in artifact tool accepted a caller-selected project');
await database.unsafe("update bp_artifacts set allowed_user_ids=array['other'] where project_id=$1 and id='service-artifact'", [serviceProject.id]);
if (JSON.parse(await nativeTools[2].execute({})).artifacts.some((item: any) => item.id === 'service-artifact')) throw Error('built-in bot listed an artifact hidden from the actor');
if (!(await nativeTools[3].execute({ artifactId: 'service-artifact' })).startsWith('Refused.')) throw Error('built-in bot read an artifact hidden from the actor');
await database.unsafe("update bp_artifacts set allowed_user_ids=array['owner'] where project_id=$1 and id='service-artifact'", [serviceProject.id]);
botAvailable = false;
if (!(await nativeTools[0].execute({})).startsWith('Refused.')) throw Error('built-in project tool retained access after bot access was revoked');
botAvailable = true;
await database.unsafe('delete from channel_memberships where channel_id=$1 and user_id=$2', [selection.channelId, actor.id]);
if (!(await nativeTools[0].execute({})).startsWith('Refused.')) throw Error('built-in project tool retained access after membership was revoked');
if (!(await callNativeWorkflowTool(serviceModule, actor, planningCall))?.isError) throw Error('workflow planning replay retained access after membership was revoked');
await database.unsafe('insert into channel_memberships(channel_id,user_id) values ($1,$2)', [selection.channelId, actor.id]);
if ((await nativeProjectTools(serviceModule, actor, { ...signedCall.run, threadId: 'unknown' }, {}, {}, async () => true)).length) throw Error('nonproject conversation was offered project tools');
let forgedThreadRejected = false;
try { await database.begin(tx => requireNativeBotContext(tx, actor, { actorId: actor.id, botId: 'team-lead', threadId: 'unmapped-thread' })); }
catch (error: any) { forgedThreadRejected = error.code === 'project_not_found'; }
if (!forgedThreadRejected) throw Error('unmapped native thread resolved a project');
await database.unsafe('insert into group_bot_threads values ($1,$2,$3,$4)', [selection.channelId, actor.id, 'team-lead', 'group-thread']);
const groupContext = await database.begin(tx => requireNativeBotContext(tx, actor, { actorId: actor.id, botId: 'team-lead', threadId: 'group-thread' }));
if (groupContext.project.id !== serviceProject.id) throw Error('group thread did not resolve its project');
const delegatedWork = { fromBotId: 'team-lead', toBotId: 'lead', actorId: actor.id, threadId: 'native-thread', runId: 'root-run', depth: 1, task: 'Coordinate the request.' };
await database.unsafe("insert into work_items(kind,key,claimed_by,lease_until,payload) values ('bot.message','claim','worker',now()+interval '5 minutes',$1::text::jsonb)", [JSON.stringify(delegatedWork)]);
const delegatedRun = { actorId: actor.id, botId: 'lead', threadId: 'native-thread', runId: 'delegated-run', depth: 1, handoff: { key: 'claim', owner: 'worker' } };
const delegatedToken = mintCallbackToken();
const delegatedAssertion = mintRunAssertion(delegatedRun, testEncryptionKey);
const delegatedVerified = await authoriseAgentCall({ presented: delegatedToken, run: delegatedAssertion, encryptionKey: testEncryptionKey,
  lookup: async hash => hash === hashCallbackToken(delegatedToken) ? { id: 'lead' } : null });
if (!delegatedVerified.ok) throw Error('delegated callback signature was rejected');
const delegatedTool = { name: 'project_context', args: {}, actorId: actor.id, botId: 'lead', run: delegatedVerified.run };
if (!(await callNativeWorkflowTool(serviceModule, actor, { ...planningCall, botId: 'lead', run: delegatedVerified.run }))?.isError) throw Error('delegated specialist was allowed to prepare a workflow');
const delegatedReply = await callNativeProjectTool(serviceModule, actor, delegatedTool);
if (delegatedReply?.isError || JSON.parse(delegatedReply!.text).role !== 'coordinator') throw Error('active delegated bot did not receive its project role');
if (!(await callNativeProjectTool(serviceModule, actor, { ...delegatedTool, name: 'project_workflows' }))?.isError) throw Error('specialist read Team Lead workflow routing tools');
if (!(await callNativeProjectTool(serviceModule, actor, { ...delegatedTool, name: 'project_work' }))?.isError) throw Error('specialist read Team Lead workflow progress');
const delegatedNativeTools = await nativeProjectTools(serviceModule, actor, delegatedVerified.run, {}, {}, async () => true);
if (delegatedNativeTools.length !== 4) throw Error('active delegated built-in bot did not receive project tools');
const [activeOccurrence] = await database.unsafe<{ occurrenceId: string; assignmentId: string }>(
  'select id as "occurrenceId",assignment_id as "assignmentId" from bp_phase_occurrences where project_id=$1 and run_id=$2', [serviceProject.id, firstSelection.runId]);
await database.unsafe("update bp_action_attempts set state='Running' where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt=1", [serviceProject.id, firstSelection.runId, activeOccurrence.occurrenceId]);
await database.unsafe("insert into bp_phase_workspace_grants(project_id,run_id,occurrence_id,tool_key) values($1,$2,$3,'test-runner')", [serviceProject.id, firstSelection.runId, activeOccurrence.occurrenceId]);
await database.begin(async tx => { await tx.unsafe(await readFile('/tmp/workspace-command-migration.sql', 'utf8')); });
const [legacyCommand] = await database.unsafe<{ digest: string }>('select argv_digest as digest from bp_phase_workspace_commands where project_id=$1 and run_id=$2 and occurrence_id=$3', [serviceProject.id,firstSelection.runId,activeOccurrence.occurrenceId]);
if (legacyCommand?.digest !== 'legacy-unverified') throw Error('legacy workspace grant was not held for reconciliation during upgrade');
await database.unsafe("insert into bp_native_action_runs(project_id,native_run_id,run_id,occurrence_id,attempt,assignment_id,actor_id,tool_key) values($1,'delegated-run',$2,$3,1,$4,$5,'test-runner')", [serviceProject.id, firstSelection.runId, activeOccurrence.occurrenceId, activeOccurrence.assignmentId, actor.id]);
let duplicateNativeAttemptRejected = false;
try { await database.unsafe("insert into bp_native_action_runs(project_id,native_run_id,run_id,occurrence_id,attempt,assignment_id,actor_id,tool_key) values($1,'duplicate-run',$2,$3,1,$4,$5,'test-runner')", [serviceProject.id, firstSelection.runId, activeOccurrence.occurrenceId, activeOccurrence.assignmentId, actor.id]); }
catch { duplicateNativeAttemptRejected = true; }
if (!duplicateNativeAttemptRejected) throw Error('one attempt accepted multiple native run identities');
await database.unsafe("insert into bp_action_attempts(project_id,run_id,occurrence_id,attempt,state) values($1,$2,$3,2,'Pending')", [serviceProject.id, firstSelection.runId, activeOccurrence.occurrenceId]);
let changedToolRejected = false;
try { await database.unsafe("insert into bp_native_action_runs(project_id,native_run_id,run_id,occurrence_id,attempt,assignment_id,actor_id,tool_key) values($1,'retry-run',$2,$3,2,$4,$5,'workspace-edit')", [serviceProject.id, firstSelection.runId, activeOccurrence.occurrenceId, activeOccurrence.assignmentId, actor.id]); }
catch { changedToolRejected = true; }
if (!changedToolRejected) throw Error('a retry changed the tool bound to the occurrence');
let nativeBindingImmutable = false;
try { await database.unsafe("update bp_native_action_runs set tool_key='workspace-edit' where project_id=$1 and native_run_id='delegated-run'", [serviceProject.id]); }
catch { nativeBindingImmutable = true; }
if (!nativeBindingImmutable) throw Error('native action binding was mutable');
const actionBinding = await database.begin(tx => requireNativeWorkspaceAction(tx, actor, delegatedVerified.run));
if (actionBinding.assignmentId !== activeOccurrence.assignmentId || actionBinding.operationKey !== `${firstSelection.runId}:1`) throw Error('native action did not resolve its active occurrence');
const originalWorkspaceUrl = process.env.WORKSPACE_PROVIDER_URL, originalWorkspaceToken = process.env.WORKSPACE_PROVIDER_TOKEN;
const originalWorkspaceInstallation = process.env.WORKSPACE_PROVIDER_INSTALLATION_ID;
const workspaceCalls: any[] = [];
const fakeWorkspace = Bun.serve({ port: 0, async fetch(request) {
  const payload = await request.json(); workspaceCalls.push({ path: new URL(request.url).pathname, payload });
  return Response.json(new URL(request.url).pathname === '/check' ? { id: 'fixture-vm', ready: true, isolated: true } : { status: 'completed', exitCode: 0 });
} });
process.env.WORKSPACE_PROVIDER_URL = 'http://127.0.0.1:' + fakeWorkspace.port;
process.env.WORKSPACE_PROVIDER_TOKEN = 'fixture-token';
delete process.env.WORKSPACE_PROVIDER_INSTALLATION_ID;
await database.unsafe("update bp_project_vms set provider_id='fixture-vm',state='Ready' where project_id=$1", [serviceProject.id]);
const workspaceModule = { ...serviceModule, async definitionFor(project: any) {
  const definition = await serviceModule.definitionFor(project);
  return { ...definition, agents: definition.agents.map(agent => agent.id === 'lead' ? { ...agent, tools: [...agent.tools, 'test-runner'] } : agent) };
} };
const workspaceTools = await nativeWorkspaceTools(workspaceModule as any, actor, delegatedVerified.run, {}, {}, async () => true);
if (workspaceTools.length !== 2) throw Error('bound active bot did not receive workspace tools');
const actionResult = JSON.parse(await workspaceTools[0].execute({ argv: ['true'] }));
if (actionResult.status !== 'completed') throw Error('authorized project workspace action failed');
if (!(await callNativeWorkspaceTool(workspaceModule as any, actor, { ...delegatedTool, name: 'project_workspace_run', args: { argv: ['true'], projectId: 'another-project' } }))?.isError) throw Error('workspace callback accepted a caller-selected project');
const protectedModule = { ...workspaceModule, async definitionFor(project: any) {
  const definition = await workspaceModule.definitionFor(project);
  return { ...definition, business: { ...definition.business!, actions: definition.business!.actions.map(action => action.id === 'clarify' ? { ...action, approvalRequired: true } : action) } };
} };
const protectedResult = await callNativeWorkspaceTool(protectedModule as any, actor, { ...delegatedTool, name: 'project_workspace_run', args: { argv: ['true'] } });
if (!protectedResult?.isError || !protectedResult.text.includes('approval gate')) throw Error('approval-protected action was permitted through workspace tools');
await workspaceTools[1].execute({});
const effectCalls = workspaceCalls.filter(call => ['/run', '/reconcile'].includes(call.path));
if (effectCalls.length !== 2 || effectCalls[0].payload.operationKey !== effectCalls[1].payload.operationKey) throw Error('workspace reconciliation did not retain its operation identity');
await database.unsafe("update bp_action_attempts set state='Completed' where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt=1", [serviceProject.id, firstSelection.runId, activeOccurrence.occurrenceId]);
if (!(await workspaceTools[0].execute({ argv: ['true'] })).startsWith('Refused.')) throw Error('completed phase could still execute workspace actions');
await database.unsafe("update bp_action_attempts set state='Running' where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt=1", [serviceProject.id, firstSelection.runId, activeOccurrence.occurrenceId]);
fakeWorkspace.stop();
if (originalWorkspaceUrl === undefined) delete process.env.WORKSPACE_PROVIDER_URL; else process.env.WORKSPACE_PROVIDER_URL = originalWorkspaceUrl;
if (originalWorkspaceToken === undefined) delete process.env.WORKSPACE_PROVIDER_TOKEN; else process.env.WORKSPACE_PROVIDER_TOKEN = originalWorkspaceToken;
if (originalWorkspaceInstallation === undefined) delete process.env.WORKSPACE_PROVIDER_INSTALLATION_ID; else process.env.WORKSPACE_PROVIDER_INSTALLATION_ID = originalWorkspaceInstallation;
await database.unsafe("update work_items set lease_until=now()-interval '1 second' where kind='bot.message' and key='claim'");
if (!(await callNativeProjectTool(serviceModule, actor, delegatedTool))?.isError) throw Error('expired delegation retained project access');
if (!(await delegatedNativeTools[0].execute({})).startsWith('Refused.')) throw Error('delegated built-in tool retained an expired lease');
if (!(await workspaceTools[0].execute({ argv: ['true'] })).startsWith('Refused.')) throw Error('workspace tool retained an expired handoff');
await database.unsafe("update work_items set lease_until=now()+interval '5 minutes',payload=jsonb_set(payload,'{toBotId}','\"team-lead\"'::jsonb) where kind='bot.message' and key='claim'");
if (!(await callNativeProjectTool(serviceModule, actor, delegatedTool))?.isError) throw Error('delegation for another bot was accepted');
for (const changed of [{ threadId: 'other-thread' }, { actorId: 'other' }, { depth: 2 }, { initiator: { kind: 'routine', id: 'other' } }]) {
  await database.unsafe("update work_items set payload=$1::text::jsonb where kind='bot.message' and key='claim'", [JSON.stringify({ ...delegatedWork, ...changed })]);
  if (!(await callNativeProjectTool(serviceModule, actor, delegatedTool))?.isError) throw Error('a mismatched delegation retained project access');
}
await database.unsafe("update work_items set payload=$1::text::jsonb,finished_at=now() where kind='bot.message' and key='claim'", [JSON.stringify(delegatedWork)]);
if (!(await callNativeProjectTool(serviceModule, actor, delegatedTool))?.isError) throw Error('a completed delegation retained project access');
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
const boundGuidance = await botGuidance(serviceModule, actor, selection.channelId, serviceAssignment.botId);
if (boundGuidance.length !== 2 || !boundGuidance.some(item => item.id === memory.id && item.revision === 2)) throw Error('bot did not receive its project-specific guidance');
const memoryReply = await callNativeProjectTool(serviceModule, actor, { ...signedCall, name: 'project_memory' });
const memoryPayload = JSON.parse(memoryReply!.text);
if (memoryReply?.isError || memoryPayload.assignmentId !== serviceAssignment.id || memoryPayload.guidance.length !== 2 || memoryPayload.guidance.some((item: any) => item.source)) throw Error('signed bot memory callback was not scoped');
const toolsWithMemory = await nativeProjectTools(serviceModule, actor, signedCall.run, {}, {}, async () => true);
if (!toolsWithMemory.find(tool => tool.name === 'project_memory')?.description.includes('intermittent failures')) throw Error('current feedback was not included in the bot turn');
let foreignBotGuidanceRejected = false;
try { await botGuidance(serviceModule, actor, selection.channelId, 'unassigned-bot'); }
catch (error: any) { foreignBotGuidanceRejected = error.code === 'project_not_found'; }
if (!foreignBotGuidanceRejected) throw Error('unassigned bot could read project guidance');
const anotherService = await serviceProjects.create(actor, { name: 'another service' }, 'another-service');
if ((await botGuidance(serviceModule, actor, 'channel-' + anotherService.id, serviceAssignment.botId)).length) throw Error('bot guidance leaked into another project');
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
await database.unsafe("insert into group_messages values ($1,$2,$3,null,'completed')", ['feedback-2', selection.channelId, actor.id]);
const conflictingSource = { conversationId: selection.channelId, messageId: 'feedback-2' };
const conflictInput = { guidance: 'Never include reproduction steps.', source: conflictingSource, entryId: memory.id, expectedRevision: 2, conflict: true };
const conflict = await recordGuidance(serviceModule, actor, serviceProject.id, serviceAssignment.id, conflictInput, 'feedback-conflict');
const conflictRetry = await recordGuidance(serviceModule, actor, serviceProject.id, serviceAssignment.id, conflictInput, 'feedback-conflict');
if (conflict.status !== 'needs-clarification' || !conflict.conflictId || conflictRetry.conflictId !== conflict.conflictId) throw Error('feedback conflict was not retained idempotently');
if ((await currentGuidance(serviceModule, actor, serviceProject.id, serviceAssignment.id)).some(item => item.id === memory.id)) throw Error('ambiguous guidance remained active');
const conflictedReply = await callNativeProjectTool(serviceModule, actor, { ...signedCall, name: 'project_memory' });
const conflictedPayload = JSON.parse(conflictedReply!.text);
if (!conflictedPayload.conflicts.some((item: any) => item.id === conflict.conflictId && item.current.includes('intermittent') && item.proposed.includes('Never'))) throw Error('bot could not inspect feedback conflict');
let unresolvedRejected = false;
try { await recordGuidance(serviceModule, actor, serviceProject.id, serviceAssignment.id, { guidance: 'Replacement.', source, entryId: memory.id, expectedRevision: 2 }, 'feedback-unresolved'); }
catch (error: any) { unresolvedRejected = error.code === 'guidance_conflict_pending'; }
if (!unresolvedRejected) throw Error('pending conflict was overwritten without clarification');
let sameMessageRejected = false;
try { await recordGuidance(serviceModule, actor, serviceProject.id, serviceAssignment.id, { guidance: 'Replacement.', source: conflictingSource, entryId: memory.id, expectedRevision: 2, resolveConflictId: conflict.conflictId }, 'feedback-same-source'); }
catch (error: any) { sameMessageRejected = error.code === 'guidance_conflict_pending'; }
if (!sameMessageRejected) throw Error('conflicting message was accepted as clarification');
await database.unsafe("insert into group_messages values ($1,$2,$3,null,'completed')", ['feedback-3', selection.channelId, actor.id]);
const resolved = await recordGuidance(serviceModule, actor, serviceProject.id, serviceAssignment.id, { guidance: 'Include reproduction steps only for intermittent failures.', source: { ...source, messageId: 'feedback-3' }, entryId: memory.id, expectedRevision: 2, resolveConflictId: conflict.conflictId }, 'feedback-resolve');
if (resolved.revision !== 3 || !(await currentGuidance(serviceModule, actor, serviceProject.id, serviceAssignment.id)).some(item => item.id === memory.id && item.revision === 3)) throw Error('clarified guidance was not applied');
if (process.env.LIVE_WORKFLOW_MODEL && process.env.LIVE_FEEDBACK) {
  const { runLiveWorkflowTurn } = await import('/app/server/live-workflow-turn.ts');
  let readMemory = false;
  const reply = await runLiveWorkflowTurn({ ownerUserId: actor.id, agentId: 'team-lead',
    systemPrompt: await Bun.file('/swe-fixture/prompts/team-lead.md').text(),
    instruction: 'Use project_memory to check your current project feedback. Explain the current instruction about reproduction steps.',
    tools: [{ name: 'project_memory', description: 'Read the current project-specific feedback for this bot.', parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => { readMemory = true; return (await callNativeProjectTool(serviceModule, actor, { ...signedCall, name: 'project_memory' }))!.text; } }] });
  const text = reply.replyText.toLowerCase();
  if (!readMemory || !text.includes('reproduction') || !text.includes('intermittent') || !text.includes('only')) throw Error('Live bot did not use the corrected project feedback.');
  console.log('Live bot read and used the corrected project-scoped feedback.');
}
const [resolvedConflict] = await database.unsafe<{ state: string; revision: number }>('select state,resolution_revision as revision from bp_memory_conflicts where id=$1', [conflict.conflictId]);
if (resolvedConflict.state !== 'Resolved' || resolvedConflict.revision !== 3) throw Error('conflict resolution history was not retained');
await database.unsafe("insert into group_messages values ($1,$2,$3,null,'completed')", ['bot-feedback-1', selection.channelId, actor.id]);
const botFeedbackCall = { name: 'project_memory_propose', actorId: actor.id, botId: verifiedCall.run.botId, run: verifiedCall.run, args: { messageId: 'bot-feedback-1', guidance: 'Use concise status updates.' } };
const botFeedback = await callNativeFeedbackTool(serviceModule, actor, botFeedbackCall);
const botFeedbackRetry = await callNativeFeedbackTool(serviceModule, actor, botFeedbackCall);
if (botFeedback?.isError || botFeedbackRetry?.isError || JSON.parse(botFeedback!.text).id !== JSON.parse(botFeedbackRetry!.text).id) throw Error('verified bot feedback was not recorded idempotently');
const forgedBotFeedback = await callNativeFeedbackTool(serviceModule, actor, { ...botFeedbackCall, args: { ...botFeedbackCall.args, projectId: 'other-project' } });
if (!forgedBotFeedback?.isError) throw Error('bot selected its own feedback project');
await database.unsafe("insert into bp_assignments(project_id,id,role_key,native_bot_id) values($1,'shadow-memory','shadow-role',$2)", [serviceProject.id, serviceAssignment.botId]);
await recordGuidance(serviceModule, actor, serviceProject.id, 'shadow-memory', { guidance: 'Separate role guidance.', source }, 'shadow-feedback');
let ambiguousMemoryRejected = false;
try { await botGuidance(serviceModule, actor, selection.channelId, serviceAssignment.botId); }
catch (error: any) { ambiguousMemoryRejected = error.code === 'project_not_found'; }
if (!ambiguousMemoryRejected) throw Error('shared bot memory accepted an ambiguous assignment');
const mainRoleMemory = await botGuidance(serviceModule, actor, selection.channelId, serviceAssignment.botId, serviceAssignment.id);
const shadowMemory = await botGuidance(serviceModule, actor, selection.channelId, serviceAssignment.botId, 'shadow-memory');
if (mainRoleMemory.length !== 3 || shadowMemory.length !== 1 || shadowMemory[0].guidance !== 'Separate role guidance.') throw Error('shared bot guidance leaked between assignments');
if ((await currentGuidance(serviceModule, actor, serviceProject.id, 'another-assignment')).length) throw Error('guidance leaked to another assignment');
await database.unsafe("insert into users values ('other')");
await database.unsafe("insert into bp_memberships(project_id,user_id,permissions) values ($1,'other',array['read','feedback'])", [serviceProject.id]);
const otherProjects = await store.listProjects({ id: 'other', role: 'user' });
if (otherProjects.length !== 1 || otherProjects[0].teamLeadChannelId !== null) throw Error('project list leaked an inaccessible conversation');
if (await businessChannelContext(serviceModule, { id: 'other', role: 'user' }, selection.channelId) !== null) throw Error('project chat context leaked to a nonmember');
if ((await currentGuidance(serviceModule, { id: 'other', role: 'user' }, serviceProject.id, serviceAssignment.id)).length) throw Error('guidance leaked without conversation membership');
let unmemberedFeedbackRejected = false;
try { await recordGuidance(serviceModule, { id: 'other', role: 'user' }, serviceProject.id, serviceAssignment.id, { guidance: 'Unauthorized.', source }, 'feedback-other'); }
catch (error: any) { unmemberedFeedbackRejected = error.code === 'feedback_source_not_found'; }
if (!unmemberedFeedbackRejected) throw Error('feedback accepted from a user without conversation access');
const routes = createProductRoutes(serviceModule, async (context: any, next: any) => { context.set('actor', actor); await next(); }, {} as any);
const workResponse = await routes.request(`/${serviceProject.id}/work-items/${firstSelection.itemId}`);
const workPayload = await workResponse.json() as any;
if (workResponse.status !== 200 || workPayload.workItem.id !== firstSelection.itemId || !workPayload.workItem.runs.some((run: any) => run.id === firstSelection.runId && run.attempts.length)) throw Error('authorized work progress was not returned');
const rejectedWorkResponse = await routes.request(`/${serviceProject.id}/work-items/${invalidSelection.itemId}`);
const rejectedWorkPayload = await rejectedWorkResponse.json() as any;
if (!rejectedWorkPayload.workItem.runs.some((run: any) => run.attempts.some((attempt: any) => attempt.rejections.length === 1 && typeof attempt.rejections[0].code === 'string'))) throw Error('work progress did not show the rejection blocker');
const otherRoutes = createProductRoutes(serviceModule, async (context: any, next: any) => { context.set('actor', { id: 'other', role: 'user' }); await next(); }, {} as any);
if ((await otherRoutes.request(`/${serviceProject.id}/work-items/${firstSelection.itemId}`)).status !== 404 || (await routes.request(`/${anotherService.id}/work-items/${firstSelection.itemId}`)).status !== 404) throw Error('work progress leaked outside its project or conversation');
const apiFeedback = await routes.request(`/${serviceProject.id}/assignments/${serviceAssignment.id}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'feedback-api' }, body: JSON.stringify({ guidance: 'Keep reports concise.', source }) });
if (apiFeedback.status !== 200 || !(await apiFeedback.json() as any).memory?.id) throw Error('feedback route failed');
const archived = await routes.request(`/${serviceProject.id}/archive`, { method: 'POST' });
if (archived.status !== 200) throw Error('archive route failed');
await archiveProject(serviceModule, actor, serviceProject.id);
const [retained] = await database.unsafe<{ count: number }>('select count(*)::int as count from bp_work_items where project_id=$1', [serviceProject.id]);
if (retained.count !== 5 + (process.env.LIVE_WORKFLOW_MODEL && !process.env.LIVE_SKIP_PHASE ? 1 : 0) + (process.env.LIVE_WORKFLOW_MODEL && !process.env.LIVE_SKIP_LEAD ? 1 : 0)) throw Error('archive did not preserve work history');
let archivedWorkRejected = false;
try { await saveWorkflowSelection(serviceModule, actor, serviceProject.id, selection, 'after-archive', schema); }
catch (error: any) { archivedWorkRejected = error.code === 'project_archived'; }
if (!archivedWorkRejected) throw Error('archived project accepted new work');
const installation = await store.ensureInstallation(actor, { environmentId: "test", blueprintKey: "swe", composeProject: "test", appUrl: "http://localhost" });
const role = { id: "qa", agentId: "qa-bot", startupChecks: [{ id: "check", kind: "role-ready" }, { id: "workspace", kind: "workspace-ready" }] };
const business = { teamLeadRole: "qa", roles: [role], artifactTypes: [{ id: "source-code", description: "source code", schema: { type: "object", properties: { path: { type: "string", minLength: 1 }, revision: { type: "string" } }, required: ["path"], additionalProperties: false } }, { id: "service-context", description: "service context", schema: { type: "object", properties: { status: { type: "string" } }, required: ["status"], additionalProperties: false } }], initialization: { requiredArtifacts: ["source-code"], workspace: { kind: "vm" } } };
await store.registerBlueprint(actor, { key: "swe", version: "1", digest: "fixture", definition: { id: "swe", business } });
const module = { database, store, definition: { version: "1" }, ensure: async () => installation.id, definitionFor: async () => ({ business }) };
const operations = projectOperations(module as any, async input => {
  await database.unsafe("insert into channels(id) values($1)", ["channel-" + input.projectId]);
  await database.unsafe("insert into channel_memberships(channel_id,user_id) values($1,$2)", ["channel-" + input.projectId, input.actor.id]);
  await database.unsafe("insert into channel_agents(channel_id,agent_id) values($1,$2)", ["channel-" + input.projectId, input.nativeBotId]);
  await database.unsafe("insert into bp_conversations(project_id,native_channel_id,team_lead_assignment_id) values($1,$2,$3)", [input.projectId, "channel-" + input.projectId, input.assignmentId]);
});
const first = await operations.create(actor, { name: "first" }, "one");
const retry = await operations.create(actor, { name: "first" }, "one");
const second = await operations.create(actor, { name: "second" }, "two");
await database.unsafe("insert into channels(id) values('legacy-channel')");
await database.unsafe("insert into channel_memberships(channel_id,user_id) values('legacy-channel',$1)", [actor.id]);
await database.unsafe("insert into intelligence_channel_mappings(channel_id,user_id,thread_id) values('legacy-channel',$1,'legacy-thread')", [actor.id]);
await database.unsafe("insert into blueprint_team_setup(thread_id,user_id,submission) values('legacy-thread',$1,$2::text::jsonb)", [actor.id, JSON.stringify({ answers: { project: '/projects/old' } })]);
const legacyGroups = [{ id: 'old-group', name: 'Old project', source: '/projects/old', conversations: [{ channelId: 'legacy-channel' }] }];
await migrateLegacyProjects(module as any, actor, legacyGroups, (input, key) => operations.create(actor, input, key));
await migrateLegacyProjects(module as any, actor, legacyGroups, (input, key) => operations.create(actor, input, key));
const legacyMappings = await database.unsafe("select g.project_id from bp_legacy_project_groups g join bp_conversations c on c.project_id=g.project_id and c.native_channel_id='legacy-channel' where g.owner_id=$1 and g.legacy_key='old-group'", [actor.id]);
if (legacyMappings.length !== 1) throw Error('legacy project mapping was not preserved across retries');
const legacySource = await database.unsafe<{ source: { path: string } }>("select source from bp_artifacts where project_id=$1 and type_key='source-code'", [legacyMappings[0].project_id]);
if (legacySource[0]?.source.path !== '/projects/old') throw Error('legacy source folder was not retained for setup');
let refusedLegacy = false;
try { await migrateLegacyProjects(module as any, actor, [{ ...legacyGroups[0], id: 'forged', source: '/projects/other' }], (input, key) => operations.create(actor, input, key)); }
catch (error: any) { refusedLegacy = error.code === 'legacy_association_unverified'; }
if (!refusedLegacy) throw Error('legacy migration accepted a mismatched source association');
await database.unsafe("insert into channels(id) values('shared-legacy-channel')");
await database.unsafe("insert into channel_memberships(channel_id,user_id) values('shared-legacy-channel',$1),('shared-legacy-channel','other')", [actor.id]);
await database.unsafe("insert into intelligence_channel_mappings(channel_id,user_id,thread_id) values('shared-legacy-channel',$1,'shared-legacy-thread')", [actor.id]);
await database.unsafe("insert into blueprint_team_setup(thread_id,user_id,submission) values('shared-legacy-thread',$1,$2::text::jsonb)", [actor.id, JSON.stringify({ answers: { project: '/projects/shared' } })]);
let refusedShared = false;
try { await migrateLegacyProjects(module as any, actor, [{ id: 'shared-group', name: 'Shared', source: '/projects/shared', conversations: [{ channelId: 'shared-legacy-channel' }] }], (input, key) => operations.create(actor, input, key)); }
catch (error: any) { refusedShared = error.code === 'legacy_association_unverified'; }
if (!refusedShared || (await database.unsafe("select 1 from bp_conversations where native_channel_id='shared-legacy-channel'")).length) throw Error('migration changed access to a shared legacy conversation');
if (legacyMappings[0].project_id === first.id || legacyMappings[0].project_id === second.id) throw Error('legacy source group merged with a new project');
const migrationRoutes = createProductRoutes(module as any, async (context: any, next: any) => { context.set('actor', actor); await next(); },
  { teamSetup: { listProjects: async () => legacyGroups } } as any);
const migratedList = await migrationRoutes.request('/');
const migratedBody: any = await migratedList.json();
if (migratedList.status !== 200 || migratedBody.legacyPending !== 0 || !migratedBody.projects.some((item: any) => item.id === legacyMappings[0].project_id)) throw Error('project list did not migrate legacy groups');
const importedLegacy = await migrationRoutes.request('/legacy/old-group/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channelIds: ['legacy-channel'] }) });
const importedLegacyBody = await importedLegacy.json() as any;
if (importedLegacy.status !== 200 || importedLegacyBody.projectId !== legacyMappings[0].project_id || importedLegacyBody.imported[0] !== 'legacy-channel') throw Error('explicit legacy import did not reuse the existing project');
const forgedLegacyImport = await migrationRoutes.request('/legacy/old-group/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channelIds: ['shared-legacy-channel'] }) });
if (forgedLegacyImport.status !== 404) throw Error('legacy import accepted a conversation from another group');
const sharedRoutes = createProductRoutes(module as any, async (context: any, next: any) => { context.set('actor', actor); await next(); },
  { teamSetup: { listProjects: async () => [{ id: 'shared-group', name: 'Shared', source: '/projects/shared', conversations: [{ channelId: 'shared-legacy-channel' }] }] } } as any);
const sharedImport = await sharedRoutes.request('/legacy/shared-group/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channelIds: ['shared-legacy-channel'] }) });
if (sharedImport.status !== 409 || (await sharedImport.json() as any).code !== 'legacy_association_unverified') throw Error('explicit import accepted a shared conversation');
const unresolvedRoutes = createProductRoutes(module as any, async (context: any, next: any) => { context.set('actor', actor); await next(); },
  { teamSetup: { listProjects: async () => [{ ...legacyGroups[0], id: 'unverified', source: '/projects/other' }] } } as any);
const unresolvedList = await unresolvedRoutes.request('/');
if (unresolvedList.status !== 200 || (await unresolvedList.json() as any).legacyPending !== 1) throw Error('an unverified legacy group hid the projects page');
if (first.id !== retry.id || first.id === second.id) throw Error("project identity or retry failed");
if (first.teamLeadChannelId !== 'channel-' + first.id || retry.teamLeadChannelId !== first.teamLeadChannelId) throw Error('project creation did not return the Team Lead conversation');
await database.unsafe("insert into channels(id) values('other-conversation')");
await database.unsafe("insert into channel_memberships(channel_id,user_id) values('other-conversation',$1)", [actor.id]);
await database.unsafe("insert into channel_agents(channel_id,agent_id) values('other-conversation','other-bot')");
await database.unsafe("insert into bp_conversations(project_id,native_channel_id,team_lead_assignment_id,created_at) select project_id,'other-conversation',id,now()-interval '1 day' from bp_assignments where project_id=$1 and role_key='qa'", [first.id]);
const retryWithOtherConversation = await operations.create(actor, { name: 'first' }, 'one');
if (retryWithOtherConversation.teamLeadChannelId !== first.teamLeadChannelId) throw Error('project retry selected a conversation without the Team Lead');
const projectList = await store.listProjects(actor);
if (!projectList.some(item => item.id === first.id && item.teamLeadChannelId === first.teamLeadChannelId)) throw Error('project listing did not include the Team Lead conversation');
const setupRoutes = createProductRoutes(module as any, async (context: any, next: any) => { context.set('actor', actor); await next(); }, {} as any);
const projectListResponse = await setupRoutes.request('/');
if (projectListResponse.status !== 200 || !(await projectListResponse.json() as any).projects.some((item: any) => item.id === first.id && item.teamLeadChannelId === first.teamLeadChannelId)) throw Error('project list route did not return the authorized Team Lead conversation');
const blockedSetup = await setupRoutes.request(`/${first.id}/initialization`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ artifacts: {} }) });
const blockedBody: any = await blockedSetup.json();
if (blockedSetup.status !== 409 || blockedBody.code !== 'artifact_required' || !blockedBody.retryable || !blockedBody.readiness.missingArtifacts.includes('source-code')) throw Error('initialization did not return a scoped retryable setup report');
const dialect = new PgDialect();
const nativeChannels = { async create(creator: typeof actor, agentIds: string[], initialize: any) {
  const channel = { id: 'api-channel-' + crypto.randomUUID() };
  await database.begin(async tx => {
    await tx.unsafe('insert into channels(id) values($1)', [channel.id]);
    await tx.unsafe('insert into channel_memberships(channel_id,user_id) values($1,$2)', [channel.id, creator.id]);
    await tx.unsafe('insert into channel_agents(channel_id,agent_id) values($1,$2)', [channel.id, agentIds[0]]);
    await initialize({ execute: async (statement: any) => { const query = dialect.sqlToQuery(statement); return tx.unsafe(query.sql, query.params); } }, channel);
  });
  return channel;
} };
const mixedLegacyRoutes = createProductRoutes(module as any, async (context: any, next: any) => { context.set('actor', actor); await next(); },
  { ...nativeChannels, teamSetup: { listProjects: async () => [{ id: 'shared-group', name: 'Shared', source: '/projects/shared', conversations: [{ channelId: 'shared-legacy-channel' }] }] } } as any);
const emptyImport = () => mixedLegacyRoutes.request('/legacy/shared-group/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channelIds: [] }) });
const emptyImported = await emptyImport(), emptyRetried = await emptyImport();
const importedId = (await emptyImported.json() as any).projectId;
if (emptyImported.status !== 200 || emptyRetried.status !== 200 || importedId !== (await emptyRetried.json() as any).projectId ||
    (await database.unsafe("select 1 from bp_conversations where native_channel_id='shared-legacy-channel'")).length) throw Error('shared legacy project was not safely imported without its conversation');
const manuallyResolvedList = await mixedLegacyRoutes.request('/');
if (manuallyResolvedList.status !== 200 || (await manuallyResolvedList.json() as any).legacyPending !== 0 ||
    (await database.unsafe("select 1 from bp_conversations where native_channel_id='shared-legacy-channel'")).length) throw Error('automatic migration did not honor the owner selection');
const creationRoutes = createProductRoutes(serviceModule, async (context: any, next: any) => { context.set('actor', actor); await next(); }, nativeChannels as any);
const createRequest = () => creationRoutes.request('/', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'api-create' }, body: JSON.stringify({ name: 'API project' }) });
const apiCreated = await createRequest(), apiCreatedAgain = await createRequest();
const apiProject: any = (await apiCreated.json() as any).project, apiRetry: any = (await apiCreatedAgain.json() as any).project;
if (apiCreated.status !== 201 || apiCreatedAgain.status !== 201 || !apiProject.teamLeadChannelId || apiProject.id !== apiRetry.id || apiProject.teamLeadChannelId !== apiRetry.teamLeadChannelId) throw Error('project create route did not deduplicate its Team Lead conversation');
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
const qaProviderRequests: any[] = [];
let qaCapability = true;
let qaMode: 'failed' | 'passed' = 'failed';
const retryProject = await operations.create(actor, { name: 'VM retry' }, 'vm-retry-project');
let ensureAttempts = 0;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const input = await request.json() as { projectId: string; source?: string; expectedRevision?: string; replace?: boolean };
    if (new URL(request.url).pathname === '/check') return Response.json({ id: 'vm-' + input.projectId, ready: true, isolated: true, ...(qaCapability ? { qaSandbox: 'git-readonly-v1' } : {}) });
    if (new URL(request.url).pathname === '/run' || new URL(request.url).pathname === '/reconcile') {
      qaProviderRequests.push(input);
      return Response.json({ status: 'completed', exitCode: 0, stdout: `fixture passes\nsecond fixture ${qaMode === 'passed' ? 'passes' : 'fails'}`, stderr: '' });
    }
    if (new URL(request.url).pathname === '/ensure' && input.projectId === retryProject.id && ++ensureAttempts === 1) return Response.json({ error: 'temporary failure' }, { status: 503 });
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
let failedEnsure = false;
try { await operations.initialize(actor, retryProject.id, { 'source-code': { path: '/projects/source' } }); }
catch (error: any) { failedEnsure = error.code === 'workspace_unavailable'; }
const [blockedVm] = await database.unsafe<{ state: string }>('select state from bp_project_vms where project_id=$1', [retryProject.id]);
if (!failedEnsure || blockedVm.state !== 'Blocked') throw Error('failed VM provisioning did not leave a retryable blocker');
await operations.initialize(actor, retryProject.id, { 'source-code': { path: '/projects/source' } });
const [recoveredVm] = await database.unsafe<{ id: string; state: string; count: number }>('select max(provider_id) as id,max(state) as state,count(*)::int as count from bp_project_vms where project_id=$1', [retryProject.id]);
if (ensureAttempts !== 2 || recoveredVm.count !== 1 || recoveredVm.id !== 'vm-' + retryProject.id || recoveredVm.state !== 'Ready') throw Error('VM provisioning retry did not retain one project binding');
imports = 0;
await Promise.all([
  operations.initialize(actor, first.id, { "source-code": { path: "/projects/source" }, "service-context": { status: "active" } }),
  operations.initialize(actor, first.id, { "source-code": { path: "/projects/source" } }),
]);
if (imports !== 1) throw Error("concurrent initialization imported twice");
const status = await readinessOperations(module as any).refresh(actor, first.id);
if (status.project.state !== "Initializing" || status.reports[0]?.status !== "Blocked") throw Error("missing bot report did not block");
const ready = await readinessOperations(module as any, async () => ({ ready: true, checks: [{ id: "check", passed: true, evidence: "bot checked" }, { id: "workspace", passed: true, evidence: "workspace checked" }] })).refresh(actor, first.id);
if (ready.project.state !== "Operational") throw Error("readiness did not activate");
await database.unsafe('update bp_assignments set revision=revision+1 where project_id=$1 and id=$2', [first.id, assignment.id]);
const changedAssignment = await readinessOperations(module as any).inspect(actor, first.id);
if (changedAssignment.project.state !== 'Initializing' || changedAssignment.reports[0]?.status !== 'Pending' || !JSON.stringify(changedAssignment.reports[0].evidence).includes('assignment changed')) throw Error('stale assignment readiness was shown as current');
await readinessOperations(module as any, async () => ({ ready: true, checks: [{ id: 'check', passed: true, evidence: 'bot checked' }, { id: 'workspace', passed: true, evidence: 'workspace checked' }] })).refresh(actor, first.id);
guestRevision = 'unexpected-revision';
const staleSource = await readinessOperations(module as any, async () => { throw Error('a bot must not run against a stale workspace'); }).refresh(actor, first.id);
if (staleSource.project.state !== 'Initializing' || staleSource.workspace?.state !== 'Blocked') throw Error('stale workspace source was accepted');
guestRevision = 'source-1';
const recovered = await readinessOperations(module as any, async () => {
  const [vm] = await database.unsafe<{ state: string }>('select state from bp_project_vms where project_id=$1', [first.id]);
  if (vm.state !== 'Ready') throw Error('bot probed a workspace still marked blocked');
  return { ready: true, checks: [{ id: 'check', passed: true, evidence: 'bot checked' }, { id: 'workspace', passed: true, evidence: 'workspace checked' }] };
}).refresh(actor, first.id);
if (recovered.project.state !== 'Operational' || recovered.workspace?.state !== 'Ready') throw Error('recovered workspace did not become operational');
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
process.env.COMPOSE_PROJECT_NAME = 'swe-readiness-fixture';
const sweModule = await createProductModule(database, '/swe-fixture');
if (!sweModule?.definition.business) throw Error('SWE blueprint did not load');
const sweOperations = projectOperations(sweModule, async input => {
  const channel = 'swe-channel-' + input.projectId;
  await database.unsafe('insert into channels(id) values($1)', [channel]);
  await database.unsafe('insert into channel_memberships(channel_id,user_id) values($1,$2)', [channel, input.actor.id]);
  await database.unsafe('insert into channel_agents(channel_id,agent_id) values($1,$2)', [channel, input.nativeBotId]);
  await database.unsafe('insert into bp_conversations(project_id,native_channel_id,team_lead_assignment_id) values($1,$2,$3)', [input.projectId, channel, input.assignmentId]);
});
const sweProject = await sweOperations.create(actor, { name: 'SWE readiness fixture' }, 'swe-readiness-fixture');
guestRevision = 'source-1';
await sweOperations.initialize(actor, sweProject.id, { 'source-code': { path: '/projects/source' } });
let blockedRole = '';
const sweReadiness = readinessOperations(sweModule, async input => ({ ready: input.roleKey !== blockedRole,
  checks: input.checks.map(check => ({ id: check.id, passed: input.roleKey !== blockedRole, evidence: 'fixture check' })) }));
const sweReady = await sweReadiness.refresh(actor, sweProject.id);
if (sweReady.project.state !== 'Operational' || sweReady.reports.length !== 5 || sweReady.reports.some(report => report.status !== 'Ready')) throw Error('all SWE specialists did not report readiness');
if (process.env.LIVE_WORKFLOW_MODEL && process.env.LIVE_READINESS) {
  const { runLiveWorkflowTurn } = await import('/app/server/live-workflow-turn.ts');
  const { createNativeReadinessProbe } = await import('/app/server/src/product/native-readiness.ts');
  const { verifyReadinessWorkspace } = await import('/app/server/src/product/readiness-workspace.ts');
  const previousProvider = { url: process.env.WORKSPACE_PROVIDER_URL, token: process.env.WORKSPACE_PROVIDER_TOKEN };
  if (process.env.LIVE_REAL_READINESS === '1') {
    let restored: { id: string; revision: string; port: number; projectId: string; installationId: string } | undefined;
    for (let attempt = 0; attempt < 300 && !restored; attempt++) {
      const failure = Bun.file('/tmp/live-readiness-provider/error.txt');
      if (await failure.exists()) throw Error(`Disposable readiness VM failed: ${await failure.text()}`);
      const metadata = Bun.file('/tmp/live-readiness-provider/provider.json');
      if (await metadata.exists()) restored = await metadata.json();
      else await Bun.sleep(1000);
    }
    if (!restored || restored.projectId !== sweProject.id || restored.installationId !== sweProject.installationId ||
        !/^obot-[a-f0-9]{24}$/.test(restored.id) || !/^[a-f0-9]{40,64}$/.test(restored.revision) ||
        !Number.isInteger(restored.port) || restored.port < 1 || restored.port > 65535) throw Error('Disposable readiness VM binding is invalid.');
    await database.unsafe("update bp_project_vms set provider_id=$2,source_revision=$3,state='Ready' where project_id=$1", [sweProject.id,restored.id,restored.revision]);
    process.env.WORKSPACE_PROVIDER_URL = `http://host.docker.internal:${restored.port}`;
    process.env.WORKSPACE_PROVIDER_TOKEN = 'restore-fixture-provider-token-0123456789';
  }
  const probe = createNativeReadinessProbe(async ({ checkWorkspace, workspaceRequired, ...turn }) => {
    const agent = sweModule.definition.agents.find(item => item.id === turn.agentId);
    if (!agent?.prompt) throw Error('Readiness specialist prompt unavailable.');
    const systemPrompt = await Bun.file(`/swe-fixture/${agent.prompt}`).text();
    return runLiveWorkflowTurn({ ...turn, systemPrompt, tools: workspaceRequired ? [{ name: 'project_workspace_check',
      description: 'Verify access to the assigned project workspace and source.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: checkWorkspace }] : [] });
  }, () => crypto.randomUUID(), input => verifyReadinessWorkspace(sweModule, input));
  const liveReady = await readinessOperations(sweModule, probe).refresh(actor, sweProject.id);
  if (liveReady.project.state !== 'Operational' || liveReady.reports.length !== 5 || liveReady.reports.some(report => report.status !== 'Ready')) {
    throw Error(`Live specialist readiness did not complete: ${JSON.stringify(liveReady.reports.map(report => ({ role: report.roleKey, status: report.status, evidence: report.evidence })))}`);
  }
  if (process.env.LIVE_REAL_READINESS === '1') {
    await database.unsafe("update bp_project_vms set provider_id=$2,source_revision='source-1',state='Ready' where project_id=$1", [sweProject.id,`vm-${sweProject.id}`]);
    if (previousProvider.url === undefined) delete process.env.WORKSPACE_PROVIDER_URL; else process.env.WORKSPACE_PROVIDER_URL = previousProvider.url;
    if (previousProvider.token === undefined) delete process.env.WORKSPACE_PROVIDER_TOKEN; else process.env.WORKSPACE_PROVIDER_TOKEN = previousProvider.token;
  }
  qaProviderRequests.length = 0;
  console.log(`Five live model-backed specialists reported readiness against the ${process.env.LIVE_REAL_READINESS === '1' ? 'real disposable VM' : 'simulated project workspace'}.`);
}
for (const role of sweModule.definition.business.roles) {
  blockedRole = role.id;
  const blocked = await sweReadiness.refresh(actor, sweProject.id);
  if (blocked.project.state !== 'Initializing' || !blocked.reports.some(report => report.roleKey === role.id && report.status === 'Blocked')) throw Error(`blocked SWE role did not hold initialization: ${role.id}`);
  let refused = false;
  try { await database.begin(tx => requireReadyReports(tx, sweProject.id, sweModule.definition.business!.roles)); } catch (error: any) { refused = error.code === 'readiness_stale'; }
  if (!refused) throw Error(`blocked SWE role did not hold work: ${role.id}`);
}
blockedRole = '';
if ((await sweReadiness.refresh(actor, sweProject.id)).project.state !== 'Operational') throw Error('corrected SWE reports did not restore readiness');
await sweOperations.initialize(actor, sweProject.id, { 'release-runbook': { procedure: 'Deploy the verified candidate to staging.' }, 'release-target': { url: 'staging-fixture' } });
if ((await sweReadiness.refresh(actor, sweProject.id)).project.state !== 'Operational') throw Error('optional release inputs blocked the team');
if (process.env.LIVE_WORKFLOW_MODEL && process.env.LIVE_SWE_PM) {
  const { runLiveWorkflowTurn } = await import('/app/server/live-workflow-turn.ts');
  const requestText = 'Add a health endpoint GET /health that returns HTTP 200 and JSON {"status":"ok"}; when requested it must return the specified status and body.';
  const selected = await saveWorkflowSelection(sweModule, actor, sweProject.id, { channelId: `swe-channel-${sweProject.id}`,
    request: requestText, interpretation: { workflowId: 'feature-development' } }, 'live-swe-pm', sweModule.schema);
  await database.unsafe("update bp_workflow_runs set state='Running',revision=revision+1 where project_id=$1 and id=$2", [sweProject.id,selected.runId]);
  await database.unsafe("update bp_dispatch_intents set state='Dispatched' where project_id=$1 and run_id=$2", [sweProject.id,selected.runId]);
  const [run] = await database.unsafe<{ planDigest: string }>('select plan_digest as "planDigest" from bp_workflow_runs where project_id=$1 and id=$2', [sweProject.id,selected.runId]);
  const initial = { installationId: sweProject.installationId, projectId: sweProject.id, runId: selected.runId as string,
    planDigest: run.planDigest, phase: 'clarify', occurrence: 1, operationKey: `${selected.runId}:1` };
  const lead = createPhaseExecutor(sweModule, async turn => {
    const saved = JSON.parse(await turn.tools[0].execute({ type: 'request-brief', payload: { objective: requestText } }));
    return { replyText: JSON.stringify({ status: 'succeeded', outputs: [{ type: 'request-brief', revisionId: saved.revisionId }], evidence: { result: saved.revisionId } }) };
  });
  const advanced = await lead.execute(initial);
  if (advanced.kind !== 'advance' || advanced.nextPhase !== 'discover') throw Error('Fixture Team Lead did not hand the request to PM.');
  await database.unsafe("update bp_dispatch_intents set state='Dispatched' where project_id=$1 and run_id=$2 and state='Pending'", [sweProject.id,selected.runId]);
  const pmRequest = { ...initial, phase: 'discover', occurrence: 2, operationKey: `${selected.runId}:2` };
  const pmPrompt = await Bun.file('/swe-fixture/prompts/product-manager.md').text();
  const outcome = await createPhaseExecutor(sweModule, turn => runLiveWorkflowTurn({ ...turn, systemPrompt: pmPrompt })).execute(pmRequest);
  if (outcome.kind !== 'advance' || outcome.nextPhase !== 'implement') throw Error(`Live PM did not hand a validated brief to Engineering: ${JSON.stringify(outcome)}`);
  const [handoff] = await database.unsafe<{ revision: string; scope: string; scenarios: number }>(`select ref->>'revisionId' as revision,
    r.payload->>'scope' as scope,jsonb_array_length(r.payload->'scenarios') as scenarios
    from bp_phase_occurrences o join bp_action_attempts a on (a.project_id,a.run_id,a.occurrence_id)=(o.project_id,o.run_id,o.id),
      jsonb_array_elements(a.input_revisions) ref join bp_artifact_revisions r on r.project_id=$1 and r.id=ref->>'revisionId'
    where o.project_id=$1 and o.run_id=$2 and o.phase_key='implement' and ref->>'type'='change-brief'`, [sweProject.id,selected.runId]);
  if (!handoff?.revision || !handoff.scope || handoff.scenarios < 1) throw Error('Engineering did not receive the saved PM brief revision and scenarios.');
  console.log('Live PM produced a validated change brief and handed it to Engineering.');
}
const releaseAction = sweModule.definition.business.actions.find(action => action.id === 'prepare-release')!;
const releaseSetupInputs = await database.begin(tx => resolveWorkflowInputs(tx, sweProject.id, null, actor.id, sweModule.definition.business!, 'release',
  { ...releaseAction, inputTypes: ['release-runbook', 'release-target'] }));
if (releaseSetupInputs.length !== 2 || !releaseSetupInputs.every(item => item.revisionId)) throw Error('release setup artifacts could not be pinned as workflow inputs');
const [qaAssignment] = await database.unsafe<{ id: string }>("select id from bp_assignments where project_id=$1 and role_key='qa'", [sweProject.id]);
const briefPayload = { scope: 'Exercise the fixture', scenarios: [{ id: 'scenario-one', expected: 'fixture passes' }, { id: 'scenario-two', expected: 'second fixture passes' }] };
const candidatePayload = { revision: 'a'.repeat(40), briefRevision: 'brief-record-revision', sourceRevision: 'source-1' };
for (const [id,type,payload] of [['brief-record','change-brief',briefPayload],['candidate-record','candidate',candidatePayload]] as const) {
  await database.unsafe("insert into bp_artifacts(project_id,id,type_key,source,status) values($1,$2,$3,'{}'::jsonb,'supplied')", [sweProject.id,id,type]);
  await database.unsafe('insert into bp_artifact_revisions(project_id,artifact_id,id,digest,payload,created_by) values($1,$2,$3,$4,$5::text::jsonb,$6)', [sweProject.id,id,`${id}-revision`,contentDigest(payload),JSON.stringify(payload),actor.id]);
}
const qaPlan = { workflow: sweModule.definition.business.workflows.find(workflow => workflow.id === 'feature-development')!, guidance: [] };
const qaDigest = contentDigest(qaPlan as any);
const planPayload = { candidateRevision: 'candidate-record-revision', briefRevision: 'brief-record-revision', environment: 'test', prerequisites: [], scenarios: [{ id: 'scenario-one', steps: ['Run fixture'], expected: 'fixture passes' }, { id: 'scenario-two', steps: ['Run second fixture'], expected: 'second fixture passes' }] };
const qaInputs = [{ type: 'candidate', revisionId: 'candidate-record-revision' }, { type: 'change-brief', revisionId: 'brief-record-revision' }];
await database.unsafe('insert into bp_work_items(project_id,id,native_channel_id,requested_by,request) values($1,$2,$3,$4,$5)', [sweProject.id,'qa-executor-item',`swe-channel-${sweProject.id}`,actor.id,'Test fixture through QA']);
await database.unsafe("insert into bp_workflow_runs(project_id,id,work_item_id,blueprint_key,blueprint_version,workflow_key,plan_digest,plan,current_phase,state,revision) values($1,'qa-executor','qa-executor-item',$2,$3,'feature-development',$4,$5::text::jsonb,'verify','Running',2)", [sweProject.id,sweProject.blueprintKey,sweProject.blueprintVersion,qaDigest,JSON.stringify(qaPlan)]);
await database.unsafe("insert into bp_phase_occurrences(project_id,run_id,id,phase_key,occurrence,action_key,assignment_id,operation_key) values($1,'qa-executor','qa-prior','clarify',100,'clarify',$2,'qa-executor:100')", [sweProject.id,qaAssignment.id]);
await database.unsafe("insert into bp_action_attempts(project_id,run_id,occurrence_id,attempt,state) values($1,'qa-executor','qa-prior',1,'Completed')", [sweProject.id]);
await database.unsafe("insert into bp_phase_results(project_id,run_id,occurrence_id,attempt,result_digest,result) values($1,'qa-executor','qa-prior',1,$2,$3::text::jsonb)", [sweProject.id,contentDigest({ outputs: [{ type: 'change-brief', revisionId: 'brief-record-revision' }] }),JSON.stringify({ outputs: [{ type: 'change-brief', revisionId: 'brief-record-revision' }] })]);
await database.unsafe("insert into bp_phase_occurrences(project_id,run_id,id,phase_key,occurrence,action_key,assignment_id,operation_key) values($1,'qa-executor','qa-executor-occurrence','verify',1,'verify',$2,'qa-executor:1')", [sweProject.id,qaAssignment.id]);
await database.unsafe("insert into bp_action_attempts(project_id,run_id,occurrence_id,attempt,state,input_revisions) values($1,'qa-executor','qa-executor-occurrence',1,'Pending',$2::text::jsonb)", [sweProject.id,JSON.stringify(qaInputs)]);
await database.unsafe("insert into bp_dispatch_intents(project_id,run_id,occurrence_id,attempt,operation_key,state) values($1,'qa-executor','qa-executor-occurrence',1,'qa-executor:1','Dispatched')", [sweProject.id]);
const executorQaRequest = { installationId: sweProject.installationId, projectId: sweProject.id, runId: 'qa-executor', planDigest: qaDigest, phase: 'verify', occurrence: 1, operationKey: 'qa-executor:1' };
let qaTurns = 0;
const qaExecutor = createPhaseExecutor(sweModule, async turn => {
  qaTurns++;
  const invoke = async (name: string, args: unknown) => {
    const tool = turn.tools.find(item => item.name === name);
    if (!tool) throw Error(`Missing QA tool: ${name}`);
    const result = await tool.execute(args);
    if (result.startsWith('Refused:')) throw Error(result);
    return JSON.parse(result);
  };
  const plan = await invoke('project_phase_output', { type: 'test-plan', payload: planPayload });
  for (const scenarioId of ['scenario-one', 'scenario-two']) await invoke('project_qa_progress', { planRevision: plan.revisionId, scenarioId, status: 'queued' });
  for (const scenarioId of ['scenario-one', 'scenario-two']) await invoke('project_qa_progress', { planRevision: plan.revisionId, scenarioId, status: 'running' });
  const execution = await invoke('project_phase_workspace', { tool: 'test-runner', argv: ['true'] });
  const results = [{ id: 'scenario-one', status: 'passed', observed: 'fixture passes', evidence: [execution.evidenceId] },
    { id: 'scenario-two', status: qaMode, observed: `second fixture ${qaMode === 'passed' ? 'passes' : 'fails'}`, evidence: [execution.evidenceId] }];
  for (const result of results) await invoke('project_qa_progress', { planRevision: plan.revisionId, scenarioId: result.id, status: result.status, observed: result.observed, evidenceId: execution.evidenceId });
  const report = await invoke('project_phase_output', { type: 'qa-evidence', payload: { candidateRevision: 'candidate-record-revision', briefRevision: 'brief-record-revision', planRevision: plan.revisionId, environment: 'test', verdict: qaMode, passPercentage: qaMode === 'passed' ? 100 : 50, results } });
  return { replyText: JSON.stringify({ status: 'succeeded', outputs: [{ type: 'test-plan', revisionId: plan.revisionId }, { type: 'qa-evidence', revisionId: report.revisionId }], evidence: { result: report.revisionId } }) };
});
qaCapability = false;
const heldQa = await qaExecutor.execute(executorQaRequest);
const heldQaReceipt = await database.unsafe("select 1 from bp_phase_activity_receipts where project_id=$1 and run_id='qa-executor'", [sweProject.id]);
if (heldQa.kind !== 'uncertain' || qaTurns !== 0 || heldQaReceipt.length !== 0) throw Error('QA started before the protected provider was available');
qaCapability = true;
const qaOutcome = await qaExecutor.execute(executorQaRequest);
const qaReplay = await qaExecutor.execute(executorQaRequest);
if (qaOutcome.kind !== 'advance' || qaOutcome.nextPhase !== 'implement' || JSON.stringify(qaReplay) !== JSON.stringify(qaOutcome) || qaTurns !== 1 || qaProviderRequests.length !== 1 || qaProviderRequests[0]?.qa?.revision !== candidatePayload.revision) throw Error(`QA dispatcher failed its protected rework transition: ${JSON.stringify(qaOutcome)}`);
qaProviderRequests.length = 0;
qaMode = 'passed';
await database.unsafe('insert into bp_work_items(project_id,id,native_channel_id,requested_by,request) values($1,$2,$3,$4,$5)', [sweProject.id,'qa-passing-item',`swe-channel-${sweProject.id}`,actor.id,'Verify fixture']);
await database.unsafe("insert into bp_workflow_runs(project_id,id,work_item_id,blueprint_key,blueprint_version,workflow_key,plan_digest,plan,current_phase,state,revision) values($1,'qa-passing','qa-passing-item',$2,$3,'feature-development',$4,$5::text::jsonb,'verify','Running',2)", [sweProject.id,sweProject.blueprintKey,sweProject.blueprintVersion,qaDigest,JSON.stringify(qaPlan)]);
await database.unsafe("insert into bp_phase_occurrences(project_id,run_id,id,phase_key,occurrence,action_key,assignment_id,operation_key) values($1,'qa-passing','qa-passing-occurrence','verify',1,'verify',$2,'qa-passing:1')", [sweProject.id,qaAssignment.id]);
await database.unsafe("insert into bp_action_attempts(project_id,run_id,occurrence_id,attempt,state,input_revisions) values($1,'qa-passing','qa-passing-occurrence',1,'Pending',$2::text::jsonb)", [sweProject.id,JSON.stringify(qaInputs)]);
await database.unsafe("insert into bp_dispatch_intents(project_id,run_id,occurrence_id,attempt,operation_key,state) values($1,'qa-passing','qa-passing-occurrence',1,'qa-passing:1','Dispatched')", [sweProject.id]);
const passingQaRequest = { ...executorQaRequest, runId: 'qa-passing', operationKey: 'qa-passing:1' };
const passingQa = await qaExecutor.execute(passingQaRequest);
if (passingQa.kind !== 'wait' || qaTurns !== 2 || qaProviderRequests.length !== 1) throw Error(`Passing QA did not await a decision: ${JSON.stringify(passingQa)}`);
await answerWorkflowDecision(sweModule, actor, sweProject.id, 'qa-passing-item', 'qa-passing', passingQa.decisionId, 'verify-only');
const verifiedQa = await qaExecutor.execute({ ...passingQaRequest, decision: { id: passingQa.decisionId, value: 'verify-only' } });
if (verifiedQa.kind !== 'complete' || qaTurns !== 2 || qaProviderRequests.length !== 1) throw Error(`Passing QA did not reach verified exactly once: ${JSON.stringify(verifiedQa)}`);
qaProviderRequests.length = 0;
if (process.env.LIVE_WORKFLOW_MODEL && process.env.LIVE_SWE_QA) {
  const { runLiveWorkflowTurn } = await import('/app/server/live-workflow-turn.ts');
  await database.unsafe('insert into bp_work_items(project_id,id,native_channel_id,requested_by,request) values($1,$2,$3,$4,$5)', [sweProject.id,'live-qa-item',`swe-channel-${sweProject.id}`,actor.id,'Test both fixture scenarios.']);
  await database.unsafe("insert into bp_workflow_runs(project_id,id,work_item_id,blueprint_key,blueprint_version,workflow_key,plan_digest,plan,current_phase,state,revision) values($1,'live-qa','live-qa-item',$2,$3,'feature-development',$4,$5::text::jsonb,'verify','Running',2)", [sweProject.id,sweProject.blueprintKey,sweProject.blueprintVersion,qaDigest,JSON.stringify(qaPlan)]);
  await database.unsafe("insert into bp_phase_occurrences(project_id,run_id,id,phase_key,occurrence,action_key,assignment_id,operation_key) values($1,'live-qa','live-qa-occurrence','verify',1,'verify',$2,'live-qa:1')", [sweProject.id,qaAssignment.id]);
  await database.unsafe("insert into bp_action_attempts(project_id,run_id,occurrence_id,attempt,state,input_revisions) values($1,'live-qa','live-qa-occurrence',1,'Pending',$2::text::jsonb)", [sweProject.id,JSON.stringify(qaInputs)]);
  await database.unsafe("insert into bp_dispatch_intents(project_id,run_id,occurrence_id,attempt,operation_key,state) values($1,'live-qa','live-qa-occurrence',1,'live-qa:1','Dispatched')", [sweProject.id]);
  const qaPrompt = await Bun.file('/swe-fixture/prompts/qa.md').text();
  const liveQa = await createPhaseExecutor(sweModule, turn => runLiveWorkflowTurn({ ...turn, systemPrompt: qaPrompt })).execute({ ...executorQaRequest, runId: 'live-qa', operationKey: 'live-qa:1' });
  if (liveQa.kind !== 'wait') throw Error(`Live QA did not produce an accepted passing report: ${JSON.stringify(liveQa)}`);
  console.log('Live QA produced an accepted report against simulated protected workspace evidence.');
  qaProviderRequests.length = 0;
}
await database.unsafe('insert into bp_work_items(project_id,id,native_channel_id,requested_by,request) values($1,$2,$3,$4,$5)', [sweProject.id,'release-item',`swe-channel-${sweProject.id}`,actor.id,'Prepare a staging release']);
await database.unsafe("insert into bp_workflow_runs(project_id,id,work_item_id,blueprint_key,blueprint_version,workflow_key,plan_digest,plan,current_phase,state,revision) values($1,'release-run','release-item',$2,$3,'feature-development',$4,$5::text::jsonb,'verify','Running',2)", [sweProject.id,sweProject.blueprintKey,sweProject.blueprintVersion,qaDigest,JSON.stringify(qaPlan)]);
await database.unsafe("insert into bp_phase_occurrences(project_id,run_id,id,phase_key,occurrence,action_key,assignment_id,operation_key) values($1,'release-run','release-prior','implement',100,'implement',$2,'release-run:100')", [sweProject.id,qaAssignment.id]);
await database.unsafe("insert into bp_action_attempts(project_id,run_id,occurrence_id,attempt,state) values($1,'release-run','release-prior',1,'Completed')", [sweProject.id]);
const releasePrior = { outputs: qaInputs };
await database.unsafe("insert into bp_phase_results(project_id,run_id,occurrence_id,attempt,result_digest,result) values($1,'release-run','release-prior',1,$2,$3::text::jsonb)", [sweProject.id,contentDigest(releasePrior),JSON.stringify(releasePrior)]);
await database.unsafe("insert into bp_phase_occurrences(project_id,run_id,id,phase_key,occurrence,action_key,assignment_id,operation_key) values($1,'release-run','release-qa','verify',1,'verify',$2,'release-run:1')", [sweProject.id,qaAssignment.id]);
await database.unsafe("insert into bp_action_attempts(project_id,run_id,occurrence_id,attempt,state,input_revisions) values($1,'release-run','release-qa',1,'Pending',$2::text::jsonb)", [sweProject.id,JSON.stringify(qaInputs)]);
await database.unsafe("insert into bp_dispatch_intents(project_id,run_id,occurrence_id,attempt,operation_key,state) values($1,'release-run','release-qa',1,'release-run:1','Dispatched')", [sweProject.id]);
const releaseQaRequest = { ...executorQaRequest, runId: 'release-run', operationKey: 'release-run:1' };
const releaseQa = await qaExecutor.execute(releaseQaRequest);
if (releaseQa.kind !== 'wait') throw Error('Release QA did not wait for the delivery decision');
await answerWorkflowDecision(sweModule, actor, sweProject.id, 'release-item', 'release-run', releaseQa.decisionId, 'ship');
const releaseAdvance = await qaExecutor.execute({ ...releaseQaRequest, decision: { id: releaseQa.decisionId, value: 'ship' } });
if (releaseAdvance.kind !== 'advance' || releaseAdvance.nextPhase !== 'prepare-release') throw Error(`Passing QA did not reach release preparation: ${JSON.stringify(releaseAdvance)}`);
const releaseRequest = { ...releaseQaRequest, phase: 'prepare-release', occurrence: 2, operationKey: 'release-run:2' };
const releaseBinding = await database.begin(tx => requireReleaseInputs(tx, releaseRequest));
if (releaseBinding.candidateRevision !== 'candidate-record-revision' || releaseBinding.candidateCommit !== candidatePayload.revision || releaseBinding.briefRevision !== 'brief-record-revision' || releaseBinding.sourceRevision !== 'source-1' || releaseBinding.target !== 'staging-fixture') throw Error('Release preflight did not bind the verified candidate and setup inputs');
let releaseTurns = 0;
const driftingReleaseExecutor = createPhaseExecutor(sweModule, async () => {
  releaseTurns++;
  await database.unsafe("update bp_project_vms set source_revision='source-2' where project_id=$1", [sweProject.id]);
  guestRevision = 'source-2';
  return { replyText: JSON.stringify({ status: 'succeeded', outputs: [], evidence: { result: releaseBinding.qaEvidenceRevision } }) };
});
const driftedRelease = await driftingReleaseExecutor.execute(releaseRequest);
await database.unsafe("update bp_project_vms set source_revision='source-1' where project_id=$1", [sweProject.id]);
guestRevision = 'source-1';
const savedDrift = await database.unsafe("select 1 from bp_phase_results where project_id=$1 and run_id='release-run' and occurrence_id=(select id from bp_phase_occurrences where project_id=$1 and run_id='release-run' and phase_key='prepare-release')", [sweProject.id]);
if (releaseTurns !== 1 || driftedRelease.kind !== 'uncertain' || savedDrift.length) throw Error('Release preparation accepted a result after its source baseline changed during the specialist turn');
let attemptInputMutationRejected = false;
try { await database.unsafe("update bp_action_attempts set input_revisions='[]'::jsonb where project_id=$1 and run_id='release-run' and occurrence_id=(select id from bp_phase_occurrences where project_id=$1 and run_id='release-run' and phase_key='prepare-release')", [sweProject.id]); } catch { attemptInputMutationRejected = true; }
if (!attemptInputMutationRejected) throw Error('A workflow attempt allowed its pinned release inputs to change');
await database.unsafe("update bp_artifacts set allowed_user_ids=array[]::text[] where project_id=$1 and type_key='release-target'", [sweProject.id]);
let restrictedReleaseRejected = false;
try { await database.begin(tx => requireReleaseInputs(tx, releaseRequest)); } catch (error: any) { restrictedReleaseRejected = error.code === 'workflow_input_stale'; }
await database.unsafe("update bp_artifacts set allowed_user_ids=null where project_id=$1 and type_key='release-target'", [sweProject.id]);
if (!restrictedReleaseRejected) throw Error('Release preflight accepted a restricted release target');
for (const type of ['release-target', 'release-runbook'] as const) {
  const rollbackProbe = new Error(`rollback missing ${type}`);
  let missingRejected = false;
  try {
    await database.begin(async tx => {
      await tx.unsafe("update bp_artifacts set status='withdrawn' where project_id=$1 and type_key=$2", [sweProject.id,type]);
      try { await requireReleaseInputs(tx, releaseRequest); } catch (error: any) { missingRejected = ['workflow_input_stale','release_evidence_unavailable'].includes(error.code); }
      throw rollbackProbe;
    });
  } catch (error) { if (error !== rollbackProbe) throw error; }
  if (!missingRejected) throw Error(`Release preflight accepted a missing ${type}`);
}
await database.unsafe("update bp_project_vms set source_revision='source-2' where project_id=$1", [sweProject.id]);
guestRevision = 'source-2';
let changedBaselineRejected = false;
try { await database.begin(tx => requireReleaseInputs(tx, releaseRequest)); } catch (error: any) { changedBaselineRejected = error.code === 'release_evidence_unavailable'; }
await database.unsafe("update bp_project_vms set source_revision='source-1' where project_id=$1", [sweProject.id]);
guestRevision = 'source-1';
if (!changedBaselineRejected) throw Error('Release preflight accepted a candidate from a different source baseline');
for (const [name, revisionId] of [['plan', releaseBinding.planRevision], ['brief', releaseBinding.briefRevision]] as const) {
  const rollbackProbe = new Error(`rollback ${name} probe`);
  let staleDependencyRejected = false;
  try {
    await database.begin(async tx => {
      await tx.unsafe(`insert into bp_artifact_revisions(project_id,artifact_id,id,digest,payload,created_by,created_at)
        select project_id,artifact_id,$3,digest,payload,created_by,created_at+interval '1 second'
        from bp_artifact_revisions where project_id=$1 and id=$2`, [sweProject.id,revisionId,`probe-newer-${name}`]);
      try { await requireReleaseInputs(tx, releaseRequest); } catch (error: any) { staleDependencyRejected = error.code === 'release_evidence_unavailable'; }
      throw rollbackProbe;
    });
  } catch (error) { if (error !== rollbackProbe) throw error; }
  if (!staleDependencyRejected) throw Error(`Release preflight accepted an out-of-date ${name}`);
}
const [releaseAttempt] = await database.unsafe<{ assignmentId: string; inputs: { type: string; revisionId: string }[] }>(`select o.assignment_id as "assignmentId",a.input_revisions as inputs
  from bp_phase_occurrences o join bp_action_attempts a on (a.project_id,a.run_id,a.occurrence_id)=(o.project_id,o.run_id,o.id)
  where o.project_id=$1 and o.run_id='release-run' and o.phase_key='prepare-release'`, [sweProject.id]);
const [foreignQa] = await database.unsafe<{ id: string }>(`select output->>'revisionId' as id from bp_phase_results result,
  jsonb_array_elements(result.result->'outputs') output where result.project_id=$1 and result.run_id='qa-passing' and output->>'type'='qa-evidence'`, [sweProject.id]);
await database.unsafe('insert into bp_work_items(project_id,id,native_channel_id,requested_by,request) values($1,$2,$3,$4,$5)', [sweProject.id,'release-forged-item',`swe-channel-${sweProject.id}`,actor.id,'Try unrelated QA evidence']);
await database.unsafe("insert into bp_workflow_runs(project_id,id,work_item_id,blueprint_key,blueprint_version,workflow_key,plan_digest,plan,current_phase,state,revision) values($1,'release-forged','release-forged-item',$2,$3,'feature-development',$4,$5::text::jsonb,'prepare-release','Running',2)", [sweProject.id,sweProject.blueprintKey,sweProject.blueprintVersion,qaDigest,JSON.stringify(qaPlan)]);
await database.unsafe("insert into bp_phase_occurrences(project_id,run_id,id,phase_key,occurrence,action_key,assignment_id,operation_key) values($1,'release-forged','release-forged-occ','prepare-release',1,'prepare-release',$2,'release-forged:1')", [sweProject.id,releaseAttempt.assignmentId]);
const forgedInputs = releaseAttempt.inputs.map(item => item.type === 'qa-evidence' ? { ...item, revisionId: foreignQa.id } : item);
await database.unsafe("insert into bp_action_attempts(project_id,run_id,occurrence_id,attempt,state,input_revisions) values($1,'release-forged','release-forged-occ',1,'Pending',$2::text::jsonb)", [sweProject.id,JSON.stringify(forgedInputs)]);
await database.unsafe("insert into bp_dispatch_intents(project_id,run_id,occurrence_id,attempt,operation_key,state) values($1,'release-forged','release-forged-occ',1,'release-forged:1','Dispatched')", [sweProject.id]);
let foreignQaRejected = false;
try { await database.begin(tx => requireReleaseInputs(tx, { ...releaseRequest, runId: 'release-forged', occurrence: 1, operationKey: 'release-forged:1' })); } catch (error: any) { foreignQaRejected = error.code === 'release_evidence_unavailable'; }
if (!foreignQaRejected) throw Error('Release preflight accepted QA evidence from a different workflow run');
await database.unsafe("insert into bp_phase_occurrences(project_id,run_id,id,phase_key,occurrence,action_key,assignment_id,operation_key) values($1,'release-forged','release-forged-qa','verify',100,'verify',$2,'release-forged:100')", [sweProject.id,qaAssignment.id]);
await database.unsafe("insert into bp_action_attempts(project_id,run_id,occurrence_id,attempt,state,input_revisions) values($1,'release-forged','release-forged-qa',1,'Completed',$2::text::jsonb)", [sweProject.id,JSON.stringify(qaInputs)]);
const forgedResult = { status: 'succeeded', outputs: [{ type: 'qa-evidence', revisionId: foreignQa.id }] };
await database.unsafe("insert into bp_phase_results(project_id,run_id,occurrence_id,attempt,result_digest,result) values($1,'release-forged','release-forged-qa',1,'invalid-digest',$2::text::jsonb)", [sweProject.id,JSON.stringify(forgedResult)]);
let forgedDigestRejected = false;
try { await database.begin(tx => requireReleaseInputs(tx, { ...releaseRequest, runId: 'release-forged', occurrence: 1, operationKey: 'release-forged:1' })); } catch (error: any) { forgedDigestRejected = error.code === 'release_evidence_unavailable'; }
if (!forgedDigestRejected) throw Error('Release preflight accepted an invalid accepted-result digest');
await database.unsafe(`insert into bp_artifact_revisions(project_id,artifact_id,id,digest,payload,created_by,created_at)
  select project_id,artifact_id,'stale-release-qa-revision',digest,payload,created_by,created_at+interval '1 second'
  from bp_artifact_revisions where project_id=$1 and id=$2`, [sweProject.id,releaseBinding.qaEvidenceRevision]);
let staleReleaseRejected = false;
try { await database.begin(tx => requireReleaseInputs(tx, releaseRequest)); } catch (error: any) { staleReleaseRejected = error.code === 'workflow_input_stale'; }
if (!staleReleaseRejected) throw Error('Release preflight accepted a stale QA report');
qaProviderRequests.length = 0;
async function releaseApprovalFixture(name: string, temporary = false) {
  const plan = temporary ? { ...qaPlan, rationale: 'Temporary delivery', guidance: ['Engineering guide'] } : qaPlan;
  const digest = contentDigest(plan as any);
  if (temporary && !selectWorkflow(sweModule.definition, sweModule.schema, { temporary: { workflow: plan.workflow, rationale: plan.rationale!, guidance: plan.guidance } }).temporary) throw Error('Temporary staging plan was not accepted');
  const runId = `approval-${name}`, itemId = `approval-item-${name}`, priorId = `approval-prior-${name}`, qaId = `approval-qa-${name}`;
  await database.unsafe('insert into bp_work_items(project_id,id,native_channel_id,requested_by,request) values($1,$2,$3,$4,$5)', [sweProject.id,itemId,`swe-channel-${sweProject.id}`,actor.id,'Review a staging release']);
  await database.unsafe("insert into bp_workflow_runs(project_id,id,work_item_id,blueprint_key,blueprint_version,workflow_key,plan_digest,plan,current_phase,state,revision) values($1,$2,$3,$4,$5,$6,$7,$8::text::jsonb,'verify','Running',2)", [sweProject.id,runId,itemId,sweProject.blueprintKey,sweProject.blueprintVersion,temporary ? null : 'feature-development',digest,JSON.stringify(plan)]);
  await database.unsafe("insert into bp_phase_occurrences(project_id,run_id,id,phase_key,occurrence,action_key,assignment_id,operation_key) values($1,$2,$3,'implement',100,'implement',$4,$5)", [sweProject.id,runId,priorId,qaAssignment.id,`${runId}:100`]);
  await database.unsafe("insert into bp_action_attempts(project_id,run_id,occurrence_id,attempt,state) values($1,$2,$3,1,'Completed')", [sweProject.id,runId,priorId]);
  await database.unsafe("insert into bp_phase_results(project_id,run_id,occurrence_id,attempt,result_digest,result) values($1,$2,$3,1,$4,$5::text::jsonb)", [sweProject.id,runId,priorId,contentDigest(releasePrior),JSON.stringify(releasePrior)]);
  await database.unsafe("insert into bp_phase_occurrences(project_id,run_id,id,phase_key,occurrence,action_key,assignment_id,operation_key) values($1,$2,$3,'verify',1,'verify',$4,$5)", [sweProject.id,runId,qaId,qaAssignment.id,`${runId}:1`]);
  await database.unsafe("insert into bp_action_attempts(project_id,run_id,occurrence_id,attempt,state,input_revisions) values($1,$2,$3,1,'Pending',$4::text::jsonb)", [sweProject.id,runId,qaId,JSON.stringify(qaInputs)]);
  await database.unsafe("insert into bp_dispatch_intents(project_id,run_id,occurrence_id,attempt,operation_key,state) values($1,$2,$3,1,$4,'Dispatched')", [sweProject.id,runId,qaId,`${runId}:1`]);
  const qaRequest = { ...executorQaRequest, runId, planDigest: digest, operationKey: `${runId}:1` };
  const qaDecision = await qaExecutor.execute(qaRequest);
  if (qaDecision.kind !== 'wait') throw Error('Approval fixture did not complete QA');
  await answerWorkflowDecision(sweModule, actor, sweProject.id, itemId, runId, qaDecision.decisionId, 'ship');
  const prepare = await qaExecutor.execute({ ...qaRequest, decision: { id: qaDecision.decisionId, value: 'ship' } });
  if (prepare.kind !== 'advance' || prepare.nextPhase !== 'prepare-release') throw Error('Approval fixture did not reach release preparation');
  const request = { ...qaRequest, phase: 'prepare-release', occurrence: 2, operationKey: `${runId}:2` };
  const binding = await database.begin(tx => requireReleaseInputs(tx, request));
  let turns = 0;
  const executor = createPhaseExecutor(sweModule, async () => { turns++; return { replyText: JSON.stringify({ status: 'succeeded', outputs: [], evidence: { result: binding.qaEvidenceRevision } }) }; });
  const waiting = await executor.execute(request);
  const replay = await executor.execute(request);
  if (waiting.kind !== 'wait' || JSON.stringify(waiting) !== JSON.stringify(replay) || turns !== 1 || !waiting.question.includes(candidatePayload.revision) || !waiting.question.includes('staging-fixture')) throw Error('Release proposal did not persist an exact, replayable approval request');
  return { runId, itemId, request, binding, waiting, executor };
}
const approvalFixture = await releaseApprovalFixture('approve');
const approvalView = await readChatProjection(sweModule, actor, sweProject.id, approvalFixture.itemId, approvalFixture.runId, 'release-view');
if (!approvalView.records.some(record => record.type === 'candidate' && record.fields.revision === candidatePayload.revision) ||
    !approvalView.records.some(record => record.type === 'qa-evidence' && record.fields.verdict === 'passed') ||
    !approvalView.records.some(record => record.type === 'release-runbook' && record.fields.procedure === 'Deploy the verified candidate to staging.') ||
    !approvalView.records.some(record => record.type === 'release-target' && record.fields.url === 'staging-fixture')) throw Error('The release view did not expose the exact reviewable candidate, QA, runbook and target');
await database.unsafe("insert into users values ('release-nonapprover'),('release-limited'),('release-approver')");
await database.unsafe("insert into bp_memberships(project_id,user_id,permissions) values($1,'release-nonapprover',array['read','work']),($1,'release-limited',array['read','work','approve']),($1,'release-approver',array['read','approve'])", [sweProject.id]);
await database.unsafe("insert into channel_memberships(channel_id,user_id) values($1,'release-nonapprover'),($1,'release-limited'),($1,'release-approver')", [`swe-channel-${sweProject.id}`]);
const nonApproverRoutes = createProductRoutes(sweModule, async (context: any, next: any) => { context.set('actor', { id: 'release-nonapprover', role: 'user' }); await next(); }, {} as any);
const nonApproverView = await nonApproverRoutes.request(`/${sweProject.id}/work-items/${approvalFixture.itemId}`);
if (!(await nonApproverView.json() as any).workItem.runs.some((run: any) => run.decisions.some((item: any) => item.id === approvalFixture.waiting.decisionId && item.approval && item.canAnswer === false))) throw Error('Release approval did not show the actor’s limited authority');
let nonApproverRejected = false;
try { await answerWorkflowDecision(sweModule, { id: 'release-nonapprover', role: 'user' }, sweProject.id, approvalFixture.itemId, approvalFixture.runId, approvalFixture.waiting.decisionId, 'approve'); } catch (error: any) { nonApproverRejected = error.code === 'project_permission_denied'; }
if (!nonApproverRejected) throw Error('Release approval accepted a user without approve permission');
await database.unsafe("update bp_artifacts set allowed_user_ids=array['owner'] where project_id=$1 and id=(select artifact_id from bp_artifact_revisions where project_id=$1 and id=$2)", [sweProject.id,approvalFixture.binding.planRevision]);
const limitedApprovalRoutes = createProductRoutes(sweModule, async (context: any, next: any) => { context.set('actor', { id: 'release-limited', role: 'user' }); await next(); }, {} as any);
const limitedApprovalView = await limitedApprovalRoutes.request(`/${sweProject.id}/work-items/${approvalFixture.itemId}`);
if ((await limitedApprovalView.json() as any).workItem.runs.some((run: any) => run.decisions.some((item: any) => item.id === approvalFixture.waiting.decisionId))) throw Error('Release approval exposed a restricted test plan');
const limitedReleaseView = await readChatProjection(sweModule, { id: 'release-limited', role: 'user' }, sweProject.id, approvalFixture.itemId, approvalFixture.runId, 'release-view');
if (limitedReleaseView.records.some(record => record.type === 'qa-evidence' || record.type === 'release-runbook' || record.type === 'release-target')) throw Error('Release role view exposed records whose QA test plan was restricted');
let limitedApprovalRejected = false;
try { await answerWorkflowDecision(sweModule, { id: 'release-limited', role: 'user' }, sweProject.id, approvalFixture.itemId, approvalFixture.runId, approvalFixture.waiting.decisionId, 'approve'); } catch (error: any) { limitedApprovalRejected = error.code === 'decision_not_found'; }
if (!limitedApprovalRejected) throw Error('Release approval accepted a user without access to the complete evidence');
await database.unsafe("update bp_artifacts set allowed_user_ids=null where project_id=$1 and id=(select artifact_id from bp_artifact_revisions where project_id=$1 and id=$2)", [sweProject.id,approvalFixture.binding.planRevision]);
await database.unsafe("update bp_project_vms set source_revision='source-2' where project_id=$1", [sweProject.id]);
guestRevision = 'source-2';
let staleApprovalRejected = false;
try { await answerWorkflowDecision(sweModule, actor, sweProject.id, approvalFixture.itemId, approvalFixture.runId, approvalFixture.waiting.decisionId, 'approve'); } catch (error: any) { staleApprovalRejected = error.code === 'release_evidence_unavailable'; }
await database.unsafe("update bp_project_vms set source_revision='source-1' where project_id=$1", [sweProject.id]);
guestRevision = 'source-1';
if (!staleApprovalRejected) throw Error('Release approval accepted a changed source baseline');
let changedProposalRejected = false;
try { await database.unsafe("update bp_release_proposals set evidence='{}'::jsonb where project_id=$1 and run_id=$2", [sweProject.id,approvalFixture.runId]); } catch { changedProposalRejected = true; }
if (!changedProposalRejected) throw Error('Release proposal evidence could be altered after review');
const releaseApprover = { id: 'release-approver', role: 'user' } as const;
await answerWorkflowDecision(sweModule, releaseApprover, sweProject.id, approvalFixture.itemId, approvalFixture.runId, approvalFixture.waiting.decisionId, 'approve');
await answerWorkflowDecision(sweModule, releaseApprover, sweProject.id, approvalFixture.itemId, approvalFixture.runId, approvalFixture.waiting.decisionId, 'approve');
const [approvalRow] = await database.unsafe<{ decision: string; target: string; candidate: string; approver: string; count: number }>(`select max(decision) as decision,max(target) as target,max(candidate_revision_id) as candidate,max(approver_id) as approver,count(*)::int as count
  from bp_release_approvals where project_id=$1 and run_id=$2`, [sweProject.id,approvalFixture.runId]);
if (approvalRow.count !== 1 || approvalRow.decision !== 'Approved' || approvalRow.target !== 'staging-fixture' || approvalRow.candidate !== 'candidate-record-revision' || approvalRow.approver !== releaseApprover.id) throw Error('Approval did not retain its exact candidate and target once');
await database.unsafe("update bp_decision_signal_intents set next_attempt_at=now()+interval '1 day' where state='Pending' and not (project_id=$1 and run_id=$2 and decision_id=$3)", [sweProject.id,approvalFixture.runId,approvalFixture.waiting.decisionId]);
let approvalSignals = 0;
const approvalEngine = Bun.serve({ port: 0, async fetch(request) { const body = await request.json() as any; approvalSignals++; return Response.json({ accepted: body.decisionId === approvalFixture.waiting.decisionId && body.value === 'approve' }); } });
const savedApprovalEngineUrl = process.env.WORKFLOW_ENGINE_URL;
process.env.WORKFLOW_ENGINE_URL = `http://127.0.0.1:${approvalEngine.port}`;
await database.unsafe("update bp_memberships set permissions=array_remove(permissions,'approve') where project_id=$1 and user_id=$2", [sweProject.id,releaseApprover.id]);
if (await dispatchPendingDecision(sweModule) || approvalSignals) throw Error('Release approval was signalled after approver authority was revoked');
let revokedApprovalRejected = false;
try { await approvalFixture.executor.execute({ ...approvalFixture.request, decision: { id: approvalFixture.waiting.decisionId, value: 'approve' } }); } catch (error: any) { revokedApprovalRejected = error.code === 'workflow_decision_unavailable'; }
await database.unsafe("update bp_memberships set permissions=array_append(permissions,'approve') where project_id=$1 and user_id=$2", [sweProject.id,releaseApprover.id]);
if (!revokedApprovalRejected) throw Error('Release continued after approver authority was revoked');
if (!await dispatchPendingDecision(sweModule) || approvalSignals !== 1) throw Error('An approve-only user’s release decision was not delivered exactly once');
process.env.WORKFLOW_ENGINE_URL = savedApprovalEngineUrl; approvalEngine.stop();
await database.unsafe("update bp_decision_signal_intents set next_attempt_at=now() where state='Pending'");
await database.unsafe("update bp_artifacts set allowed_user_ids=array['owner'] where project_id=$1 and id=(select artifact_id from bp_artifact_revisions where project_id=$1 and id=$2)", [sweProject.id,approvalFixture.binding.planRevision]);
let revokedEvidenceRejected = false;
try { await approvalFixture.executor.execute({ ...approvalFixture.request, decision: { id: approvalFixture.waiting.decisionId, value: 'approve' } }); } catch (error: any) { revokedEvidenceRejected = error.code === 'workflow_decision_unavailable'; }
await database.unsafe("update bp_artifacts set allowed_user_ids=null where project_id=$1 and id=(select artifact_id from bp_artifact_revisions where project_id=$1 and id=$2)", [sweProject.id,approvalFixture.binding.planRevision]);
if (!revokedEvidenceRejected) throw Error('Release continued after the approver lost access to the test plan');
await database.unsafe("update bp_project_vms set source_revision='source-2' where project_id=$1", [sweProject.id]);
guestRevision = 'source-2';
let changedApprovedSourceRejected = false;
try { await approvalFixture.executor.execute({ ...approvalFixture.request, decision: { id: approvalFixture.waiting.decisionId, value: 'approve' } }); } catch (error: any) { changedApprovedSourceRejected = error.code === 'release_evidence_unavailable'; }
await database.unsafe("update bp_project_vms set source_revision='source-1' where project_id=$1", [sweProject.id]);
guestRevision = 'source-1';
if (!changedApprovedSourceRejected) throw Error('Release continued after the approved candidate source changed');
const approvedRelease = await approvalFixture.executor.execute({ ...approvalFixture.request, decision: { id: approvalFixture.waiting.decisionId, value: 'approve' } });
if (approvedRelease.kind !== 'advance' || approvedRelease.nextPhase !== 'deploy') throw Error(`Approved release did not reach the held deployment phase: ${JSON.stringify(approvedRelease)}`);
const deploymentRequest = { ...approvalFixture.request, phase: 'deploy', occurrence: 3, operationKey: `${approvalFixture.runId}:3` };
const approvedBinding = await database.begin(tx => requireApprovedRelease(tx, deploymentRequest));
if (approvedBinding.candidateCommit !== candidatePayload.revision || approvedBinding.target !== 'staging-fixture' || approvedBinding.approverId !== releaseApprover.id || !/^[a-f0-9]{64}$/.test(approvedBinding.operationId)) throw Error('Deployment proof lost its approved candidate, target or approver');
const [deployAttempt] = await database.unsafe<{ assignmentId: string; inputs: any[] }>(`select o.assignment_id as "assignmentId",a.input_revisions as inputs from bp_phase_occurrences o
  join bp_action_attempts a on (a.project_id,a.run_id,a.occurrence_id)=(o.project_id,o.run_id,o.id)
  where o.project_id=$1 and o.run_id=$2 and o.phase_key='deploy' and o.occurrence=3`, [sweProject.id,approvalFixture.runId]);
await database.unsafe("insert into bp_phase_occurrences(project_id,run_id,id,phase_key,occurrence,action_key,assignment_id,operation_key) values($1,$2,'later-deploy','deploy',4,'deploy',$3,$4)", [sweProject.id,approvalFixture.runId,deployAttempt.assignmentId,`${approvalFixture.runId}:4`]);
await database.unsafe("insert into bp_action_attempts(project_id,run_id,occurrence_id,attempt,state,input_revisions) values($1,$2,'later-deploy',1,'Pending',$3::text::jsonb)", [sweProject.id,approvalFixture.runId,JSON.stringify(deployAttempt.inputs)]);
await database.unsafe("insert into bp_dispatch_intents(project_id,run_id,occurrence_id,attempt,operation_key,state) values($1,$2,'later-deploy',1,$3,'Dispatched')", [sweProject.id,approvalFixture.runId,`${approvalFixture.runId}:4`]);
let reusedApprovalRejected = false;
try { await database.begin(tx => requireApprovedRelease(tx, { ...deploymentRequest, occurrence: 4, operationKey: `${approvalFixture.runId}:4` })); } catch (error: any) { reusedApprovalRejected = error.code === 'release_approval_unavailable'; }
if (!reusedApprovalRejected) throw Error('A release approval was reused for a later deployment occurrence');
await database.unsafe("update bp_memberships set permissions=array_remove(permissions,'approve') where project_id=$1 and user_id=$2", [sweProject.id,releaseApprover.id]);
let revokedDeploymentRejected = false;
try { await database.begin(tx => requireApprovedRelease(tx, deploymentRequest)); } catch (error: any) { revokedDeploymentRejected = error.code === 'release_approval_unavailable'; }
await database.unsafe("update bp_memberships set permissions=array_append(permissions,'approve') where project_id=$1 and user_id=$2", [sweProject.id,releaseApprover.id]);
if (!revokedDeploymentRejected) throw Error('Deployment proof accepted an approver whose authority was revoked');
const heldDeployment = await approvalFixture.executor.execute(deploymentRequest);
if (heldDeployment.kind !== 'uncertain') throw Error('An unconnected deployment phase did not remain held');
const rejectFixture = await releaseApprovalFixture('reject');
await answerWorkflowDecision(sweModule, actor, sweProject.id, rejectFixture.itemId, rejectFixture.runId, rejectFixture.waiting.decisionId, 'reject');
const rejectedRelease = await rejectFixture.executor.execute({ ...rejectFixture.request, decision: { id: rejectFixture.waiting.decisionId, value: 'reject' } });
if (rejectedRelease.kind !== 'blocked') throw Error('A rejected release did not stop before deployment');
const forgedDeploymentFixture = await releaseApprovalFixture('forged');
await answerWorkflowDecision(sweModule, actor, sweProject.id, forgedDeploymentFixture.itemId, forgedDeploymentFixture.runId, forgedDeploymentFixture.waiting.decisionId, 'approve');
await forgedDeploymentFixture.executor.execute({ ...forgedDeploymentFixture.request, decision: { id: forgedDeploymentFixture.waiting.decisionId, value: 'approve' } });
const forgedDeploymentRequest = { ...forgedDeploymentFixture.request, phase: 'deploy', occurrence: 3, operationKey: `${forgedDeploymentFixture.runId}:3` };
if ((await database.begin(tx => claimPhaseActivity(tx, forgedDeploymentRequest))).status !== 'claimed') throw Error('Forged deployment fixture did not claim its phase');
let inventedDeploymentRejected = false;
try { await database.begin(tx => savePhaseOutput(tx, forgedDeploymentRequest, 'deployment-evidence', { candidateRevision: 'candidate-record-revision', target: 'staging-fixture', receipt: 'invented', verified: true })); } catch (error: any) { inventedDeploymentRejected = error.code === 'deployment_evidence_unavailable'; }
if (!inventedDeploymentRejected) throw Error('An invented deployment receipt was accepted');
const stageEffects = new Map<string, any>();
let stageDeploys = 0, stageLookups = 0, stageVerifications = 0;
let leaveStageUncertain = false;
const stageToken = 's'.repeat(32);
const stageServer = Bun.serve({ port: 0, async fetch(request) {
  if (request.headers.get('authorization') !== `Bearer ${stageToken}`) return new Response(null, { status: 401 });
  const input = await request.json() as any, path = new URL(request.url).pathname;
  const prior = stageEffects.get(input.operationId);
  if (prior && (prior.projectId !== input.projectId || prior.candidateDigest !== input.candidateDigest || prior.target !== input.target)) return new Response(null, { status: 409 });
  if (path === '/internal/staging/deploy') {
    stageDeploys++;
    const receipt = prior ?? { ...input, receiptId: 'fixture-stage-receipt' };
    stageEffects.set(input.operationId, receipt);
    if (stageDeploys === 1 || leaveStageUncertain) return new Response(null, { status: 503 }); // The effect committed before its response was lost.
    return Response.json({ status: 'confirmed', receipt });
  }
  if (path === '/internal/staging/lookup') {
    stageLookups++;
    return prior ? Response.json({ status: 'confirmed', receipt: prior }) : Response.json({ status: 'not-found', ...input });
  }
  if (path === '/internal/staging/verify') {
    stageVerifications++;
    if (!prior || input.receiptId !== prior.receiptId || stageVerifications === 1) return new Response(null, { status: 503 });
    return Response.json({ status: 'verified', verification: { ...prior, verificationId: 'fixture-verification' } });
  }
  return new Response(null, { status: 404 });
} });
const priorStage = originalStagingEnv;
process.env.STAGING_TARGET_URL = `http://127.0.0.1:${stageServer.port}`;
process.env.STAGING_TARGET_TOKEN = stageToken;
process.env.STAGING_TARGET_ID = 'different-target';
if ((await approvalFixture.executor.execute(deploymentRequest)).kind !== 'uncertain' || stageDeploys) throw Error('Deployment used an unconfigured target');
process.env.STAGING_TARGET_ID = 'staging-fixture';
if ((await reconcileReleaseDeployment(sweModule, deploymentRequest)).kind !== 'uncertain' || stageDeploys || stageEffects.size) throw Error('Unclaimed deployment reconciliation dispatched a staging effect');
await database.unsafe("update bp_memberships set permissions=array_remove(permissions,'approve') where project_id=$1 and user_id=$2", [sweProject.id,releaseApprover.id]);
if ((await approvalFixture.executor.execute(deploymentRequest)).kind !== 'uncertain' || stageDeploys) throw Error('Deployment started after approval authority was revoked');
await database.unsafe("update bp_memberships set permissions=array_append(permissions,'approve') where project_id=$1 and user_id=$2", [sweProject.id,releaseApprover.id]);
const lostStage = await approvalFixture.executor.execute(deploymentRequest);
if (lostStage.kind !== 'uncertain' || stageEffects.size !== 1 || stageDeploys !== 1) throw Error('A lost deployment receipt did not hold the committed effect');
let recoveryCalls = 0;
let recoveryStatusMode = 'valid';
const recoveryEngine = Bun.serve({ port: 0, async fetch(request) {
  const body = await request.json() as any;
  if (body.run.projectId !== sweProject.id || body.run.runId !== approvalFixture.runId) return new Response(null, { status: 400 });
  if (new URL(request.url).pathname === '/status') return recoveryStatusMode === 'invalid' ? Response.json({ snapshot: { state: 'invented', reason: 'private detail' } }) : recoveryStatusMode === 'failed' ? new Response(null, { status: 503 }) : recoveryStatusMode === 'known' ? Response.json({ snapshot: { state: 'uncertain', reason: 'The specialist returned an invalid result.' } }) : recoveryStatusMode === 'release-target' ? Response.json({ snapshot: { state: 'uncertain', reason: 'The disposable staging target is not configured.' } }) : recoveryStatusMode === 'release-rejected' ? Response.json({ snapshot: { state: 'blocked', reason: 'The release was rejected by the approver.' } }) : recoveryStatusMode === 'retries' ? Response.json({ snapshot: { state: 'blocked', reason: 'The specialist failed after 2 attempts.' } }) : recoveryStatusMode === 'model-blocked' ? Response.json({ snapshot: { state: 'blocked', reason: 'The specialist returned an invalid result.' } }) : recoveryStatusMode === 'prototype' ? Response.json({ snapshot: { state: 'uncertain', reason: '__proto__' } }) : Response.json({ snapshot: { state: 'uncertain', reason: 'private detail' } });
  if (new URL(request.url).pathname !== '/reconcile') return new Response(null, { status: 404 });
  recoveryCalls++; return Response.json({ accepted: true });
} });
const oldRecoveryEngine = process.env.WORKFLOW_ENGINE_URL;
process.env.WORKFLOW_ENGINE_URL = `http://127.0.0.1:${recoveryEngine.port}`;
const visibleEngineState = await readWorkflowEngineState(sweModule, actor, sweProject.id, approvalFixture.itemId, approvalFixture.runId);
if (JSON.stringify(visibleEngineState) !== JSON.stringify({state:'uncertain'})) throw Error('Workflow status exposed unexpected engine details');
const statusRoutes = createProductRoutes(sweModule, async (context: any, next: any) => { context.set('actor', actor); await next(); }, {} as any);
const statusResponse = await statusRoutes.request(`/${sweProject.id}/work-items/${approvalFixture.itemId}/runs/${approvalFixture.runId}/status`);
if (!statusResponse.ok || JSON.stringify(await statusResponse.json()) !== JSON.stringify({state:'uncertain'})) throw Error('Workflow status route did not return its filtered state');
recoveryStatusMode = 'known';
const knownStatus = await readWorkflowEngineState(sweModule, actor, sweProject.id, approvalFixture.itemId, approvalFixture.runId);
if (JSON.stringify(knownStatus) !== JSON.stringify({state:'uncertain',reasonCode:'specialist-result-invalid'})) throw Error('A recognized safe blocker was not categorized');
recoveryStatusMode = 'release-target';
if (JSON.stringify(await readWorkflowEngineState(sweModule, actor, sweProject.id, approvalFixture.itemId, approvalFixture.runId)) !== JSON.stringify({state:'uncertain',reasonCode:'release-target-unavailable'})) throw Error('A recognized release blocker was not categorized');
recoveryStatusMode = 'release-rejected';
if (JSON.stringify(await readWorkflowEngineState(sweModule, actor, sweProject.id, approvalFixture.itemId, approvalFixture.runId)) !== JSON.stringify({state:'blocked',reasonCode:'release-rejected'})) throw Error('An authorized release rejection was not categorized');
recoveryStatusMode = 'retries';
if (JSON.stringify(await readWorkflowEngineState(sweModule, actor, sweProject.id, approvalFixture.itemId, approvalFixture.runId)) !== JSON.stringify({state:'blocked',reasonCode:'specialist-retries-exhausted'})) throw Error('A bounded server retry outcome was not categorized');
recoveryStatusMode = 'release-target';
await database.unsafe("update bp_artifacts set allowed_user_ids=array[]::text[] where project_id=$1 and type_key='release-target'", [sweProject.id]);
if (JSON.stringify(await readWorkflowEngineState(sweModule, actor, sweProject.id, approvalFixture.itemId, approvalFixture.runId)) !== JSON.stringify({state:'uncertain'})) throw Error('A restricted artifact leaked through the blocker category');
await database.unsafe("update bp_artifacts set allowed_user_ids=null where project_id=$1 and type_key='release-target'", [sweProject.id]);
await database.unsafe("update bp_artifacts set allowed_user_ids=array[]::text[] where project_id=$1 and id=(select artifact_id from bp_artifact_revisions where project_id=$1 and id=$2)", [sweProject.id,approvalFixture.binding.planRevision]);
if (JSON.stringify(await readWorkflowEngineState(sweModule, actor, sweProject.id, approvalFixture.itemId, approvalFixture.runId)) !== JSON.stringify({state:'uncertain'})) throw Error('A restricted QA plan leaked through the blocker category');
await database.unsafe("update bp_artifacts set allowed_user_ids=null where project_id=$1 and id=(select artifact_id from bp_artifact_revisions where project_id=$1 and id=$2)", [sweProject.id,approvalFixture.binding.planRevision]);
recoveryStatusMode = 'model-blocked';
if (JSON.stringify(await readWorkflowEngineState(sweModule, actor, sweProject.id, approvalFixture.itemId, approvalFixture.runId)) !== JSON.stringify({state:'blocked'})) throw Error('A model-provided blocked reason was misclassified');
recoveryStatusMode = 'prototype';
if (JSON.stringify(await readWorkflowEngineState(sweModule, actor, sweProject.id, approvalFixture.itemId, approvalFixture.runId)) !== JSON.stringify({state:'uncertain'})) throw Error('An unrecognized engine reason was exposed');
for (const mode of ['invalid','failed']) {
  recoveryStatusMode = mode;
  const unavailable = await statusRoutes.request(`/${sweProject.id}/work-items/${approvalFixture.itemId}/runs/${approvalFixture.runId}/status`);
  if (unavailable.status !== 409 || (await unavailable.text()).includes('private detail')) throw Error('Invalid engine status did not fail closed');
}
recoveryStatusMode = 'valid';

let wrongStatusRejected = false;
try { await readWorkflowEngineState(sweModule, actor, sweProject.id, 'wrong-item', approvalFixture.runId); } catch { wrongStatusRejected = true; }
if (!wrongStatusRejected) throw Error('Workflow status accepted another work item');
let unrelatedRecoveryRejected = false;
try { await reconcileWorkflow(sweModule, actor, sweProject.id, 'wrong-item', approvalFixture.runId); } catch { unrelatedRecoveryRejected = true; }
if (!unrelatedRecoveryRejected || recoveryCalls) throw Error('Recovery accepted the wrong work item');
const recoveryView = await readWorkItem(sweModule, actor, sweProject.id, approvalFixture.itemId);
if (!recoveryView.runs.find(run => run.id === approvalFixture.runId)?.canRecover) throw Error('Requester cannot see recovery action');
let otherRequesterRejected = false;
try { await reconcileWorkflow(sweModule, releaseApprover, sweProject.id, approvalFixture.itemId, approvalFixture.runId); } catch { otherRequesterRejected = true; }
if (!otherRequesterRejected || recoveryCalls) throw Error('Recovery was accepted from someone other than the original requester');
let otherStatusRejected = false;
try { await readWorkflowEngineState(sweModule, { id: 'release-nonapprover', role: 'user' }, sweProject.id, approvalFixture.itemId, approvalFixture.runId); } catch { otherStatusRejected = true; }
if (!otherStatusRejected) throw Error('Workflow status accepted another requester');
await database.unsafe('delete from channel_memberships where channel_id=$1 and user_id=$2', [`swe-channel-${sweProject.id}`,actor.id]);
let revokedRecoveryRejected = false;
try { await reconcileWorkflow(sweModule, actor, sweProject.id, approvalFixture.itemId, approvalFixture.runId); } catch { revokedRecoveryRejected = true; }
if (!revokedRecoveryRejected || recoveryCalls) throw Error('Recovery ignored revoked conversation access');
let revokedStatusRejected = false;
try { await readWorkflowEngineState(sweModule, actor, sweProject.id, approvalFixture.itemId, approvalFixture.runId); } catch { revokedStatusRejected = true; }
if (!revokedStatusRejected) throw Error('Workflow status ignored revoked conversation access');
await database.unsafe('insert into channel_memberships(channel_id,user_id) values($1,$2)', [`swe-channel-${sweProject.id}`,actor.id]);
await database.unsafe("update bp_memberships set permissions=array_remove(permissions,'work') where project_id=$1 and user_id=$2", [sweProject.id,actor.id]);
const revokedRecoveryView = await readWorkItem(sweModule, actor, sweProject.id, approvalFixture.itemId);
if (revokedRecoveryView.runs.find(run => run.id === approvalFixture.runId)?.canRecover) throw Error('Recovery action remained visible without work permission');
let workPermissionRejected = false;
try { await reconcileWorkflow(sweModule, actor, sweProject.id, approvalFixture.itemId, approvalFixture.runId); } catch { workPermissionRejected = true; }
if (!workPermissionRejected || recoveryCalls) throw Error('Recovery ignored revoked work permission');
let workStatusRejected = false;
try { await readWorkflowEngineState(sweModule, actor, sweProject.id, approvalFixture.itemId, approvalFixture.runId); } catch { workStatusRejected = true; }
if (!workStatusRejected) throw Error('Workflow status ignored revoked work permission');
await database.unsafe("update bp_memberships set permissions=array_append(permissions,'work') where project_id=$1 and user_id=$2", [sweProject.id,actor.id]);
await reconcileWorkflow(sweModule, actor, sweProject.id, approvalFixture.itemId, approvalFixture.runId);
if (recoveryCalls !== 1) throw Error('Authorized recovery was not signaled');
process.env.WORKFLOW_ENGINE_URL = oldRecoveryEngine; recoveryEngine.stop();
const lostStageReplay = await approvalFixture.executor.execute(deploymentRequest);
if (lostStageReplay.kind !== 'uncertain' || stageDeploys !== 1) throw Error('An uncertain deployment was repeated without reconciliation');
let alternateStageCalls = 0;
const alternateStage = Bun.serve({ port: 0, async fetch() { alternateStageCalls++; return Response.json({ status: 'not-found' }); } });
process.env.STAGING_TARGET_URL = `http://127.0.0.1:${alternateStage.port}`;
if ((await approvalFixture.executor.reconcile(deploymentRequest)).kind !== 'uncertain' || alternateStageCalls || stageDeploys !== 1) throw Error('An uncertain effect was reconciled against a different staging service');
process.env.STAGING_TARGET_URL = `http://127.0.0.1:${stageServer.port}`; alternateStage.stop();
let changedStageBindingRejected = false;
try { await database.unsafe("update bp_release_target_bindings set endpoint_origin='http://other' where project_id=$1 and run_id=$2", [sweProject.id,approvalFixture.runId]); } catch { changedStageBindingRejected = true; }
if (!changedStageBindingRejected) throw Error('A pending staging service binding was mutable');
const firstStageReconcile = await approvalFixture.executor.reconcile(deploymentRequest);
if (firstStageReconcile.kind !== 'uncertain' || stageLookups !== 1 || stageVerifications !== 1 || stageDeploys !== 1) throw Error('A recovered receipt did not wait for independent verification');
const finalStage = await approvalFixture.executor.reconcile(deploymentRequest);
if (finalStage.kind !== 'complete' || stageEffects.size !== 1 || stageDeploys !== 1 || stageLookups !== 1 || stageVerifications !== 2) throw Error(`A verified staging effect did not complete once: ${JSON.stringify(finalStage)}`);
const finalStageReplay = await approvalFixture.executor.execute(deploymentRequest);
if (JSON.stringify(finalStageReplay) !== JSON.stringify(finalStage) || stageDeploys !== 1) throw Error('A verified deployment was repeated on replay');
const [stageEvidence] = await database.unsafe<{ state: string; receipt: any; verification: any }>('select state,receipt,verification from bp_release_effects where project_id=$1 and run_id=$2', [sweProject.id,approvalFixture.runId]);
if (stageEvidence.state !== 'Confirmed' || stageEvidence.receipt?.receiptId !== 'fixture-stage-receipt' || stageEvidence.verification?.verificationId !== 'fixture-verification') throw Error('Verified deployment evidence was not retained');
await database.unsafe('insert into intelligence_channel_mappings values($1,$2,$3)', [`swe-channel-${sweProject.id}`,actor.id,'swe-lead-thread']);
const sweLead = { name: 'project_work', args: {}, actorId: actor.id, botId: 'team-lead', run: { actorId: actor.id, botId: 'team-lead', threadId: 'swe-lead-thread' } };
const leadWork = await callNativeProjectTool(sweModule, actor, sweLead);
const leadRun = !leadWork?.isError && JSON.parse(leadWork!.text).runs.find((run: any) => run.runId === approvalFixture.runId);
const linkedDeployment = leadRun?.outputs.find((output: any) => output.type === 'deployment-evidence');
if (!linkedDeployment) throw Error('Team Lead did not receive run-bound deployment evidence');
const leadEvidence = await callNativeProjectTool(sweModule, actor, { ...sweLead, name: 'project_artifact_read', args: { artifactId: linkedDeployment.artifactId, revisionId: linkedDeployment.revisionId } });
if (leadEvidence?.isError || JSON.parse(leadEvidence!.text).payload?.receipt !== 'fixture-stage-receipt') throw Error('Team Lead could not read its authorized deployment evidence');
if (process.env.LIVE_WORKFLOW_MODEL && process.env.LIVE_RELEASE_SUMMARY) {
  const { runLiveWorkflowTurn } = await import('/app/server/live-workflow-turn.ts');
  let readEvidence = false;
  const leadReply = await runLiveWorkflowTurn({ ownerUserId: actor.id, agentId: 'team-lead',
    systemPrompt: await Bun.file('/swe-fixture/prompts/team-lead.md').text(),
    instruction: `Summarize the outcome of run ${approvalFixture.runId}. Use project_work to locate that run, then read its deployment-evidence artifact with project_artifact_read before reporting the target and receipt.`,
    tools: [{ name: 'project_work', description: 'List the project work and authorized output references.', parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => (await callNativeProjectTool(sweModule, actor, sweLead))!.text },
    { name: 'project_artifact_read', description: 'Read an authorized artifact revision.', parameters: { type: 'object', properties: {
      artifactId: { type: 'string' }, revisionId: { type: 'string' },
    }, required: ['artifactId','revisionId'], additionalProperties: false }, execute: async (args: any) => {
      const result = await callNativeProjectTool(sweModule, actor, { ...sweLead, name: 'project_artifact_read', args });
      if (!result || result.isError) return 'Refused.';
      if (args.artifactId === linkedDeployment.artifactId && args.revisionId === linkedDeployment.revisionId) readEvidence = true;
      return result.text;
    } }] });
  if (!readEvidence || !leadReply.replyText.includes('staging-fixture') || !leadReply.replyText.includes('fixture-stage-receipt')) throw Error('Live Team Lead did not report the verified fixture release from its evidence.');
  console.log('Live Team Lead reported a verified fixture release from its authorized evidence.');
}
await database.unsafe('update bp_artifacts set allowed_user_ids=array[$3]::text[] where project_id=$1 and id=$2', [sweProject.id,linkedDeployment.artifactId,'release-approver']);
const restrictedLeadWork = await callNativeProjectTool(sweModule, actor, sweLead);
if (JSON.parse(restrictedLeadWork!.text).runs.find((run: any) => run.runId === approvalFixture.runId)?.outputs.some((output: any) => output.type === 'deployment-evidence')) throw Error('Team Lead work exposed a restricted deployment artifact');
if (!(await callNativeProjectTool(sweModule, actor, { ...sweLead, name: 'project_artifact_read', args: { artifactId: linkedDeployment.artifactId, revisionId: linkedDeployment.revisionId } }))?.isError) throw Error('Team Lead read a restricted deployment artifact');
await database.unsafe('update bp_artifacts set allowed_user_ids=null where project_id=$1 and id=$2', [sweProject.id,linkedDeployment.artifactId]);
const [linkedPlan] = await database.unsafe<{ artifactId: string }>('select artifact_id as "artifactId" from bp_artifact_revisions where project_id=$1 and id=$2', [sweProject.id,approvalFixture.binding.planRevision]);
await database.unsafe('update bp_artifacts set allowed_user_ids=array[$3]::text[] where project_id=$1 and id=$2', [sweProject.id,linkedPlan.artifactId,'release-approver']);
const hiddenPlanWork = await callNativeProjectTool(sweModule, actor, sweLead);
if (JSON.parse(hiddenPlanWork!.text).runs.find((run: any) => run.runId === approvalFixture.runId)?.outputs.some((output: any) => output.type === 'deployment-evidence')) throw Error(`Team Lead work exposed a release linked to a restricted QA plan: ${JSON.stringify({run: JSON.parse(hiddenPlanWork!.text).runs.find((run: any) => run.runId === approvalFixture.runId), plan: approvalFixture.binding.planRevision})}`);
await database.unsafe('update bp_artifacts set allowed_user_ids=null where project_id=$1 and id=$2', [sweProject.id,linkedPlan.artifactId]);


let changedStageReceiptRejected = false;
try { await database.unsafe("update bp_release_effects set receipt='{}'::jsonb where project_id=$1 and run_id=$2", [sweProject.id,approvalFixture.runId]); } catch { changedStageReceiptRejected = true; }
if (!changedStageReceiptRejected) throw Error('A confirmed release receipt could be modified');
const notFoundFixture = await releaseApprovalFixture('not-found');
await answerWorkflowDecision(sweModule, actor, sweProject.id, notFoundFixture.itemId, notFoundFixture.runId, notFoundFixture.waiting.decisionId, 'approve');
await notFoundFixture.executor.execute({ ...notFoundFixture.request, decision: { id: notFoundFixture.waiting.decisionId, value: 'approve' } });
const notFoundRequest = { ...notFoundFixture.request, phase: 'deploy', occurrence: 3, operationKey: `${notFoundFixture.runId}:3` };
if ((await database.begin(tx => claimPhaseActivity(tx, notFoundRequest))).status !== 'claimed') throw Error('Not-found fixture did not claim its phase');
const notFoundBinding = await database.begin(tx => requireApprovedRelease(tx, notFoundRequest));
await database.unsafe("insert into bp_release_effects(project_id,run_id,proposal_id,operation_key,state) values($1,$2,$3,$4,'Dispatching')", [sweProject.id,notFoundFixture.runId,notFoundBinding.proposalId,notFoundBinding.operationId]);
await database.unsafe('insert into bp_release_target_bindings(project_id,run_id,proposal_id,target_id,endpoint_origin) values($1,$2,$3,$4,$5)', [sweProject.id,notFoundFixture.runId,notFoundBinding.proposalId,'staging-fixture',`http://127.0.0.1:${stageServer.port}`]);
const recoveredAbsentEffect = await notFoundFixture.executor.reconcile(notFoundRequest);
if (recoveredAbsentEffect.kind !== 'complete' || stageEffects.size !== 2 || stageDeploys !== 2 || stageLookups !== 2 || !stageEffects.has(notFoundBinding.operationId)) throw Error('An absent reserved effect did not reconcile and deploy once');
if ((await notFoundFixture.executor.reconcile(notFoundRequest)).kind !== 'complete' || stageDeploys !== 2) throw Error('A reconciled absent effect was repeated');
const rejectedTemporary = await releaseApprovalFixture('temporary-rejected', true);
const beforeRejectedTemporary = stageDeploys;
await answerWorkflowDecision(sweModule, actor, sweProject.id, rejectedTemporary.itemId, rejectedTemporary.runId, rejectedTemporary.waiting.decisionId, 'reject');
const rejectedTemporaryOutcome = await rejectedTemporary.executor.execute({ ...rejectedTemporary.request, decision: { id: rejectedTemporary.waiting.decisionId, value: 'reject' } });
if (rejectedTemporaryOutcome.kind !== 'blocked' || stageDeploys !== beforeRejectedTemporary) throw Error('Rejected temporary release did not stop before deployment');
const temporaryRelease = await releaseApprovalFixture('temporary', true);
await answerWorkflowDecision(sweModule, actor, sweProject.id, temporaryRelease.itemId, temporaryRelease.runId, temporaryRelease.waiting.decisionId, 'approve');
await temporaryRelease.executor.execute({ ...temporaryRelease.request, decision: { id: temporaryRelease.waiting.decisionId, value: 'approve' } });
const temporaryDeploy = { ...temporaryRelease.request, phase: 'deploy', occurrence: 3, operationKey: `${temporaryRelease.runId}:3` };
const previousDeployCount = stageDeploys;
leaveStageUncertain = true;
if ((await temporaryRelease.executor.execute(temporaryDeploy)).kind !== 'uncertain') throw Error('Temporary release did not hold its lost receipt');
leaveStageUncertain = false;
if ((await temporaryRelease.executor.reconcile(temporaryDeploy)).kind !== 'complete' || stageDeploys !== previousDeployCount + 1) throw Error('Temporary release did not reconcile one staging effect');
if ((await temporaryRelease.executor.reconcile(temporaryDeploy)).kind !== 'complete' || stageDeploys !== previousDeployCount + 1) throw Error('Temporary release repeated its staging effect');
// Preserve one real lost-response operation for the subsequent snapshot test.
const snapshotFixture = await releaseApprovalFixture('snapshot-uncertain');
await answerWorkflowDecision(sweModule, actor, sweProject.id, snapshotFixture.itemId, snapshotFixture.runId, snapshotFixture.waiting.decisionId, 'approve');
await snapshotFixture.executor.execute({ ...snapshotFixture.request, decision: { id: snapshotFixture.waiting.decisionId, value: 'approve' } });
const snapshotRequest = { ...snapshotFixture.request, phase: 'deploy', occurrence: 3, operationKey: `${snapshotFixture.runId}:3` };
leaveStageUncertain = true;
if ((await snapshotFixture.executor.execute(snapshotRequest)).kind !== 'uncertain') throw Error('Snapshot fixture did not preserve an uncertain effect');
leaveStageUncertain = false;
const [snapshotEffect] = await database.unsafe<{state: string}>("select state from bp_release_effects where project_id=$1 and run_id=$2", [sweProject.id,snapshotFixture.runId]);
if (snapshotEffect?.state !== 'Uncertain') throw Error('Snapshot fixture is not uncertain');
for (const [key, value] of Object.entries({ STAGING_TARGET_URL: priorStage.url, STAGING_TARGET_TOKEN: priorStage.token, STAGING_TARGET_ID: priorStage.id })) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
stageServer.stop();
qaProviderRequests.length = 0;
await database.unsafe('insert into bp_work_items(project_id,id,native_channel_id,requested_by,request) values($1,$2,$3,$4,$5)', [sweProject.id,'qa-item',`swe-channel-${sweProject.id}`,actor.id,'Test fixture']);
await database.unsafe("insert into bp_workflow_runs(project_id,id,work_item_id,blueprint_key,blueprint_version,workflow_key,plan_digest,plan,current_phase,state,revision) values($1,'qa-run','qa-item',$2,$3,'feature-development',$4,$5::text::jsonb,'verify','Running',2)", [sweProject.id,sweProject.blueprintKey,sweProject.blueprintVersion,qaDigest,JSON.stringify(qaPlan)]);
await database.unsafe("insert into bp_phase_occurrences(project_id,run_id,id,phase_key,occurrence,action_key,assignment_id,operation_key) values($1,'qa-run','qa-prior','implement',100,'implement',$2,'qa-run:100')", [sweProject.id,qaAssignment.id]);
await database.unsafe("insert into bp_action_attempts(project_id,run_id,occurrence_id,attempt,state) values($1,'qa-run','qa-prior',1,'Completed')", [sweProject.id]);
const qaPrior = { outputs: qaInputs };
await database.unsafe("insert into bp_phase_results(project_id,run_id,occurrence_id,attempt,result_digest,result) values($1,'qa-run','qa-prior',1,$2,$3::text::jsonb)", [sweProject.id,contentDigest(qaPrior),JSON.stringify(qaPrior)]);
await database.unsafe("insert into bp_phase_occurrences(project_id,run_id,id,phase_key,occurrence,action_key,assignment_id,operation_key) values($1,'qa-run','qa-occurrence','verify',1,'verify',$2,'qa-run:1')", [sweProject.id,qaAssignment.id]);
await database.unsafe("insert into bp_action_attempts(project_id,run_id,occurrence_id,attempt,state,input_revisions) values($1,'qa-run','qa-occurrence',1,'Pending',$2::text::jsonb)", [sweProject.id,JSON.stringify(qaInputs)]);
await database.unsafe("insert into bp_dispatch_intents(project_id,run_id,occurrence_id,attempt,operation_key,state) values($1,'qa-run','qa-occurrence',1,'qa-run:1','Dispatched')", [sweProject.id]);
const qaRequest = { installationId: sweProject.installationId, projectId: sweProject.id, runId: 'qa-run', planDigest: qaDigest, phase: 'verify', occurrence: 1, operationKey: 'qa-run:1' };
const qaClaim = await database.begin(tx => claimPhaseActivity(tx, qaRequest));
if (qaClaim.status !== 'claimed') throw Error('QA fixture did not claim its phase');
const savedPlan = await database.begin(tx => savePhaseOutput(tx, qaRequest, 'test-plan', planPayload));
const progressInput = { planRevision: savedPlan.revisionId, scenarioId: 'scenario-one', status: 'queued' as const };
const queued = await database.begin(tx => recordQaProgress(tx, qaRequest, progressInput));
const repeatedQueued = await database.begin(tx => recordQaProgress(tx, qaRequest, progressInput));
if (queued.sequence !== 1 || repeatedQueued.sequence !== 1) throw Error('QA queued progress was not idempotent');
let incompleteQueueRejected = false;
try { await database.begin(tx => recordQaProgress(tx, qaRequest, { ...progressInput, status: 'running' })); } catch (error: any) { incompleteQueueRejected = error.code === 'qa_progress_incomplete'; }
if (!incompleteQueueRejected) throw Error('QA execution started before all planned scenarios were queued');
await database.begin(tx => recordQaProgress(tx, qaRequest, { ...progressInput, scenarioId: 'scenario-two' }));
await database.begin(tx => recordQaProgress(tx, qaRequest, { ...progressInput, status: 'running' }));
let inventedQaEvidenceRejected = false;
try { await database.begin(tx => recordQaProgress(tx, qaRequest, { ...progressInput, status: 'passed', observed: 'fixture passes', evidenceId: 'missing' })); } catch (error: any) { inventedQaEvidenceRejected = error.code === 'invalid_qa_progress'; }
if (!inventedQaEvidenceRejected) throw Error('QA progress accepted invented test evidence');
await database.begin(tx => reservePhaseWorkspace(tx, qaRequest, 'test-runner', ['true']));
qaCapability = false;
let missingQaCapabilityRejected = false;
try { await database.begin(tx => runPhaseWorkspace(sweModule, tx, qaRequest, 'test-runner', ['true'])); } catch (error: any) { missingQaCapabilityRejected = error.code === 'qa_sandbox_unavailable'; }
if (!missingQaCapabilityRejected || qaProviderRequests.length !== 0) throw Error('QA dispatched to a provider without the protected sandbox capability');
qaCapability = true;
const qaExecution = await database.begin(tx => runPhaseWorkspace(sweModule, tx, qaRequest, 'test-runner', ['true']));
if (qaExecution.status !== 'completed' || !qaExecution.evidenceId || qaProviderRequests[0]?.qa?.revision !== candidatePayload.revision) throw Error('QA did not dispatch the exact candidate to its protected workspace');
const qaReceipt = qaExecution.evidenceId;
const passedProgress = await database.begin(tx => recordQaProgress(tx, qaRequest, { ...progressInput, status: 'passed', observed: 'fixture passes', evidenceId: qaReceipt }));
if (passedProgress.sequence !== 3) throw Error('QA final progress did not follow its running state');
const passedReplay = await database.begin(tx => recordQaProgress(tx, qaRequest, { ...progressInput, status: 'passed', observed: 'fixture passes', evidenceId: qaReceipt }));
if (passedReplay.sequence !== 3) throw Error('QA final progress did not deduplicate a replay');
let changedProgressRejected = false;
try { await database.begin(tx => recordQaProgress(tx, qaRequest, { ...progressInput, status: 'passed', observed: 'fixture', evidenceId: qaReceipt })); } catch (error: any) { changedProgressRejected = error.code === 'qa_progress_conflict'; }
if (!changedProgressRejected) throw Error('QA progress replay changed its observation');
let reversedQaProgressRejected = false;
try { await database.begin(tx => recordQaProgress(tx, qaRequest, { ...progressInput, status: 'running' })); } catch (error: any) { reversedQaProgressRejected = error.code === 'invalid_qa_progress'; }
if (!reversedQaProgressRejected) throw Error('final QA progress was allowed to move backwards');
await database.begin(tx => recordQaProgress(tx, qaRequest, { ...progressInput, scenarioId: 'scenario-two', status: 'blocked', reason: 'Fixture unavailable' }));
const qaReport = { candidateRevision: 'candidate-record-revision', briefRevision: 'brief-record-revision', planRevision: savedPlan.revisionId, environment: 'test', verdict: 'pending', passPercentage: 50,
  results: [{ id: 'scenario-one', status: 'passed', observed: 'fixture passes', evidence: [qaReceipt] }, { id: 'scenario-two', status: 'blocked', reason: 'Fixture unavailable' }] };
const savedQaReport = await database.begin(tx => savePhaseOutput(tx, qaRequest, 'qa-evidence', qaReport));
let changedQaReportRejected = false;
try { await database.begin(tx => savePhaseOutput(tx, qaRequest, 'qa-evidence', { ...qaReport, results: [{ ...qaReport.results[0], observed: 'invented' }, qaReport.results[1]] })); } catch (error: any) { changedQaReportRejected = error.code === 'qa_evidence_unverified'; }
if (!changedQaReportRejected) throw Error('QA report accepted a result different from actual progress');
let qaHistoryImmutable = false;
try { await database.unsafe("delete from bp_qa_scenario_events where project_id=$1 and run_id='qa-run'", [sweProject.id]); } catch { qaHistoryImmutable = true; }
if (!qaHistoryImmutable) throw Error('QA scenario history was mutable');
await database.unsafe("update bp_artifacts set allowed_user_ids=array['owner'] where project_id=$1 and id='candidate-record'", [sweProject.id]);
let qaSessionValid = true;
const qaAuth = createRequireUser({ handler: () => new Response(), api: { getSession: async input => {
  if (!input.query?.disableCookieCache) throw Error('session recheck used cached authentication');
  return qaSessionValid ? { user: { id: actor.id, email: 'fixture@example.test' } } : null;
} } }, { rolesForUser: async () => ['user'] });
const qaRoutes = createProductRoutes(sweModule, qaAuth, {} as any);
const qaVisible = await qaRoutes.request(`/${sweProject.id}/work-items/qa-item`);
if (!(await qaVisible.json() as any).workItem.runs.some((run: any) => run.qaProgress.some((item: any) => item.scenarioId === 'scenario-one' && item.status === 'passed' && item.total === 2))) throw Error('authorized QA scenario progress was not visible');
const wrongChatRun = await qaRoutes.request(`/${sweProject.id}/work-items/qa-item/runs/qa-passing/views/qa-view/events`);
if (wrongChatRun.status !== 404) throw Error('QA chat view accepted a run from a different work item');
const qaStream = await qaRoutes.request(`/${sweProject.id}/work-items/qa-item/runs/qa-run/views/qa-view/events`);
if (qaStream.status !== 200 || !qaStream.body) throw Error('authorized QA chat state stream did not open');
const qaReader = qaStream.body.getReader();
let qaStreamBuffer = '';
const readQaEvent = async () => {
  while (!qaStreamBuffer.includes('\n\n')) {
    const next = await Promise.race([qaReader.read(), Bun.sleep(10000).then(() => { throw Error('QA chat state event timed out'); })]);
    if (next.done) throw Error('QA chat state stream closed unexpectedly');
    qaStreamBuffer += new TextDecoder().decode(next.value);
  }
  const boundary = qaStreamBuffer.indexOf('\n\n');
  const frame = qaStreamBuffer.slice(0, boundary); qaStreamBuffer = qaStreamBuffer.slice(boundary + 2);
  return JSON.parse(frame.split('\n').find(line => line.startsWith('data:'))!.slice(5).trim());
};
const qaSnapshot = await readQaEvent();
const visibleScenario = qaSnapshot.snapshot?.qaProgress?.find((item: any) => item.scenarioId === 'scenario-one');
if (qaSnapshot.type !== 'STATE_SNAPSHOT' || qaSnapshot.snapshot.conversationId !== `swe-channel-${sweProject.id}` || qaSnapshot.snapshot.runId !== 'qa-run' || qaSnapshot.snapshot.qaProgress.length !== 2 || visibleScenario?.steps?.[0] !== 'Run fixture' || visibleScenario?.expected !== 'fixture passes' || visibleScenario?.observed !== 'fixture passes' || visibleScenario?.evidenceId !== qaReceipt || visibleScenario?.reportVerdict !== null) throw Error('QA chat snapshot did not include authorized scenario details or showed an unaccepted final verdict');
const pmStream = await qaRoutes.request(`/${sweProject.id}/work-items/qa-item/runs/qa-run/views/pm-view/events`);
if (!pmStream.body) throw Error('PM domain view did not open');
const pmReader = pmStream.body.getReader();
let pmBuffer = '';
const readPmEvent = async () => {
  while (!pmBuffer.includes('\n\n')) {
    const next = await Promise.race([pmReader.read(), Bun.sleep(10000).then(() => { throw Error('PM chat state event timed out'); })]);
    if (next.done) throw Error('PM chat state stream closed unexpectedly');
    pmBuffer += new TextDecoder().decode(next.value);
  }
  const boundary = pmBuffer.indexOf('\n\n');
  const frame = pmBuffer.slice(0, boundary); pmBuffer = pmBuffer.slice(boundary + 2);
  return JSON.parse(frame.split('\n').find(line => line.startsWith('data:'))!.slice(5).trim());
};
const pmSnapshot = await readPmEvent();
const pmBrief = pmSnapshot.snapshot?.records?.find((record: any) => record.type === 'change-brief');
if (pmSnapshot.type !== 'STATE_SNAPSHOT' || pmBrief?.fields?.scope !== briefPayload.scope || pmBrief?.fields?.scenarios?.length !== 2 || pmSnapshot.snapshot.records.some((record: any) => record.type === 'candidate')) throw Error('PM role view did not project only configured, authorized fields');
await database.unsafe("update bp_artifacts set allowed_user_ids=array[]::text[] where project_id=$1 and id='candidate-record'", [sweProject.id]);
const restrictedPm = await readPmEvent();
if (restrictedPm.type !== 'STATE_DELTA' || restrictedPm.delta[0]?.value?.records?.length !== 0) throw Error('PM view retained a record whose run inputs became restricted');
const qaDelta = await readQaEvent();
if (qaDelta.type !== 'STATE_DELTA' || qaDelta.delta[0]?.value?.qaProgress?.length !== 0) throw Error('QA chat delta retained a restricted candidate');
const reconnectedStream = await qaRoutes.request(`/${sweProject.id}/work-items/qa-item/runs/qa-run/views/qa-view/events`);
if (!reconnectedStream.body) throw Error('QA chat reconnect did not open');
const reconnectedReader = reconnectedStream.body.getReader();
const reconnectedFrame = new TextDecoder().decode((await reconnectedReader.read()).value);
const reconnectedSnapshot = JSON.parse(reconnectedFrame.split('\n').find(line => line.startsWith('data:'))!.slice(5).trim());
if (reconnectedSnapshot.type !== 'STATE_SNAPSHOT' || reconnectedSnapshot.snapshot.qaProgress.length !== 0) throw Error('QA reconnect did not start from a newly authorized snapshot');
await reconnectedReader.cancel();
await database.unsafe("update bp_artifacts set allowed_user_ids=array['owner'] where project_id=$1 and id='candidate-record'", [sweProject.id]);
const restoredQa = await readQaEvent();
if (restoredQa.type !== 'STATE_DELTA' || restoredQa.delta[0]?.value?.qaProgress?.length !== 2) throw Error('QA chat delta did not restore newly authorized scenario details');
await database.unsafe("update bp_artifacts set allowed_user_ids=array[]::text[] where project_id=$1 and id=$2", [sweProject.id, savedQaReport.artifactId]);
const restrictedReport = await readQaEvent();
if (restrictedReport.type !== 'STATE_DELTA' || restrictedReport.delta[0]?.value?.qaProgress?.length !== 0) throw Error('QA chat delta retained details from a restricted report');
await database.unsafe("update bp_artifacts set allowed_user_ids=array['owner'] where project_id=$1 and id=$2", [sweProject.id, savedQaReport.artifactId]);
await database.unsafe('delete from channel_memberships where channel_id=$1 and user_id=$2', [`swe-channel-${sweProject.id}`, actor.id]);
let clearedQaSnapshot = await readQaEvent();
if (clearedQaSnapshot.type === 'STATE_DELTA') clearedQaSnapshot = await readQaEvent();
if (clearedQaSnapshot.type !== 'STATE_SNAPSHOT' || clearedQaSnapshot.snapshot !== null) throw Error('QA chat stream did not clear state after conversation access was revoked');
await qaReader.cancel();
await pmReader.cancel();
await database.unsafe('insert into channel_memberships(channel_id,user_id) values($1,$2)', [`swe-channel-${sweProject.id}`, actor.id]);
await database.unsafe("update bp_artifacts set allowed_user_ids=array['owner'] where project_id=$1 and id='candidate-record'", [sweProject.id]);
const sessionStream = await qaRoutes.request(`/${sweProject.id}/work-items/qa-item/runs/qa-run/views/qa-view/events`);
if (!sessionStream.body) throw Error('QA session stream did not open');
const sessionReader = sessionStream.body.getReader();
const sessionSnapshot = new TextDecoder().decode((await sessionReader.read()).value);
if (!sessionSnapshot.includes('STATE_SNAPSHOT')) throw Error('QA session stream did not start with a snapshot');
qaSessionValid = false;
const revokedSession = new TextDecoder().decode((await sessionReader.read()).value);
if (!revokedSession.includes('"snapshot":null')) throw Error('QA session stream did not clear after session revocation');
qaSessionValid = true;
await sessionReader.cancel();
const pendingQaResult = { projectId: sweProject.id, runId: qaRequest.runId, occurrenceId: qaClaim.phase.occurrenceId,
  assignmentId: qaClaim.phase.assignmentId, actionId: qaClaim.phase.actionId, attempt: qaClaim.phase.attempt, runRevision: qaClaim.phase.runRevision,
  status: 'succeeded', outputs: [{ type: 'test-plan', revisionId: savedPlan.revisionId }, { type: 'qa-evidence', revisionId: savedQaReport.revisionId }], evidence: { result: savedQaReport.revisionId } };
await database.begin(tx => recordPhaseResult(tx, qaRequest, pendingQaResult));
const pendingQa = await database.begin(tx => applyPhaseResult(tx, qaRequest, pendingQaResult));
if (pendingQa.kind !== 'wait') throw Error(`Incomplete QA did not wait: ${JSON.stringify(pendingQa)}`);
const pendingQaView = await qaRoutes.request(`/${sweProject.id}/work-items/qa-item`);
if (!(await pendingQaView.json() as any).workItem.runs.some((run: any) => run.qaProgress.some((item: any) => item.scenarioId === 'scenario-one' && item.reportVerdict === 'pending'))) throw Error('QA view did not expose the accepted final verdict');
await answerWorkflowDecision(sweModule, actor, sweProject.id, 'qa-item', 'qa-run', pendingQa.decisionId, 'retry-qa');
const retryQa = await qaExecutor.execute({ ...qaRequest, decision: { id: pendingQa.decisionId, value: 'retry-qa' } });
if (retryQa.kind !== 'advance' || retryQa.nextPhase !== 'verify') throw Error(`Incomplete QA did not resume at a fresh verify occurrence: ${JSON.stringify(retryQa)}`);
await database.unsafe(`insert into bp_artifact_revisions(project_id,artifact_id,id,digest,payload,created_by,created_at)
  select project_id,artifact_id,'newer-candidate-revision',digest,payload,created_by,created_at+interval '1 second'
  from bp_artifact_revisions where project_id=$1 and artifact_id='candidate-record' and id='candidate-record-revision'`, [sweProject.id]);
const staleQaView = await qaRoutes.request(`/${sweProject.id}/work-items/qa-item`);
if (!(await staleQaView.json() as any).workItem.runs.some((run: any) => run.qaProgress.some((item: any) => item.scenarioId === 'scenario-one' && item.stale === true))) throw Error('outdated QA scenario progress was presented as current');
await database.unsafe("insert into users values ('qa-limited')");
await database.unsafe("insert into bp_memberships(project_id,user_id,permissions) values ($1,'qa-limited',array['read'])", [sweProject.id]);
await database.unsafe("insert into channel_memberships(channel_id,user_id) values($1,'qa-limited')", [`swe-channel-${sweProject.id}`]);
await database.unsafe("update bp_action_attempts set reason='Private candidate detail' where project_id=$1 and run_id='qa-run' and occurrence_id='qa-occurrence'", [sweProject.id]);
const limitedQaRoutes = createProductRoutes(sweModule, async (context: any, next: any) => { context.set('actor', { id: 'qa-limited', role: 'user' }); await next(); }, {} as any);
const qaHidden = await limitedQaRoutes.request(`/${sweProject.id}/work-items/qa-item`);
const hiddenWork = (await qaHidden.json() as any).workItem;
if (hiddenWork.runs.some((run: any) => run.qaProgress.length || run.attempts.some((attempt: any) => attempt.reason === 'Private candidate detail'))) throw Error('QA progress or failure reason exposed a restricted candidate');
console.log("Verified PostgreSQL project identity, concurrent source import, and readiness state.");
server.stop();
await client.close();
