import { ProductError, type ProductQuery } from './access.js';
import type { ProductModule } from './module.js';
import { contentDigest, type JsonValue } from './store.js';
import { resolvePhaseActivity, type PhaseRequest } from './phase-activity.js';
import { authorizedWorkspaceActionInTransaction } from './workspace-actions.js';
import { createHash } from 'node:crypto';

/** Derive the Git revision from the pinned, authorized candidate rather than tool arguments. */
export async function resolveQaCandidate(tx: ProductQuery, request: PhaseRequest, phase: Awaited<ReturnType<typeof resolvePhaseActivity>>, tool: 'workspace-edit' | 'test-runner') {
  if (phase.definition.projectType !== 'software-development' || !phase.action.outputTypes.includes('qa-evidence')) return undefined;
  const invalid = () => new ProductError(409, 'qa_candidate_unavailable', 'QA requires the exact authorized candidate and source baseline.');
  const candidate = phase.inputRevisions.find(item => item.type === 'candidate');
  const brief = phase.inputRevisions.find(item => item.type === 'change-brief');
  if (tool !== 'test-runner' || !candidate || !brief) throw invalid();
  const [row] = await tx.unsafe<{ payload: Record<string, JsonValue>; digest: string; sourceRevision: string | null }>(`
    select r.payload,r.digest,v.source_revision as "sourceRevision" from bp_artifacts a
    join bp_artifact_revisions r on r.project_id=a.project_id and r.artifact_id=a.id
    join bp_project_vms v on v.project_id=a.project_id and v.state='Ready'
    where a.project_id=$1 and a.type_key='candidate' and a.status='supplied' and r.id=$2
      and (a.allowed_user_ids is null or $3=any(a.allowed_user_ids))
      and not exists (select 1 from bp_artifact_revisions newer where newer.project_id=r.project_id and newer.artifact_id=r.artifact_id
        and (newer.created_at,newer.id)>(r.created_at,r.id)) for share of a,r,v`, [request.projectId,candidate.revisionId,phase.actorId]);
  if (!row || contentDigest(row.payload) !== row.digest || typeof row.payload.revision !== 'string' || !/^[a-f0-9]{40,64}$/.test(row.payload.revision) ||
      row.payload.briefRevision !== brief.revisionId || !row.sourceRevision || row.payload.sourceRevision !== row.sourceRevision) throw invalid();
  return row.payload.revision;
}

/** Commit this reservation before contacting the workspace provider. */
export async function reservePhaseWorkspace(tx: ProductQuery, request: PhaseRequest, tool: 'workspace-edit' | 'test-runner', argv: string[]) {
  if (!['workspace-edit', 'test-runner'].includes(tool) || !Array.isArray(argv) || !argv.length || !argv[0] || argv.length > 128 ||
      argv.some(item => typeof item !== 'string' || item.includes('\0') || item.length > 8192)) {
    throw new ProductError(422, 'invalid_workspace_action', 'Provide an authorized tool and command.');
  }
  await tx.unsafe('select id from bp_workflow_runs where project_id=$1 and id=$2 for update', [request.projectId,request.runId]);
  const phase = await resolvePhaseActivity(tx, request);
  const [receipt] = await tx.unsafe<{ requestDigest: string; state: string }>(`select request_digest as "requestDigest",state
    from bp_phase_activity_receipts where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt=$4 for update`,
  [request.projectId,request.runId,phase.occurrenceId,phase.attempt]);
  if (!receipt || receipt.state !== 'Running' || receipt.requestDigest !== contentDigest(request as unknown as JsonValue)) throw new ProductError(409, 'phase_unavailable', 'The active phase claim could not be verified.');
  const agent = phase.definition.agents.find(item => item.id === phase.botId);
  if (!agent?.tools.includes(tool) || phase.action.approvalRequired) throw new ProductError(403, 'tool_denied', 'This phase cannot use that workspace tool.');
  const qaRevision = await resolveQaCandidate(tx, request, phase, tool);
  await tx.unsafe(`insert into bp_phase_workspace_grants(project_id,run_id,occurrence_id,tool_key) values($1,$2,$3,$4) on conflict do nothing`, [request.projectId,request.runId,phase.occurrenceId,tool]);
  const [grant] = await tx.unsafe<{ tool: string }>('select tool_key as tool from bp_phase_workspace_grants where project_id=$1 and run_id=$2 and occurrence_id=$3 for share', [request.projectId,request.runId,phase.occurrenceId]);
  if (!grant || grant.tool !== tool) throw new ProductError(409, 'workspace_tool_conflict', 'The phase is bound to a different workspace tool.');
  const digest = contentDigest((qaRevision ? { argv, qaRevision } : argv) as unknown as JsonValue);
  await tx.unsafe(`insert into bp_phase_workspace_commands(project_id,run_id,occurrence_id,tool_key,argv_digest) values($1,$2,$3,$4,$5) on conflict do nothing`, [request.projectId,request.runId,phase.occurrenceId,tool,digest]);
  const [command] = await tx.unsafe<{ tool: string; digest: string }>('select tool_key as tool,argv_digest as digest from bp_phase_workspace_commands where project_id=$1 and run_id=$2 and occurrence_id=$3 for share', [request.projectId,request.runId,phase.occurrenceId]);
  if (!command || command.tool !== tool || command.digest !== digest) throw new ProductError(409, 'workspace_command_conflict', 'This phase is already bound to a different workspace command.');
}

/** Use only from the server-owned tool for the current claimed phase. */
export async function runPhaseWorkspace(module: ProductModule, tx: ProductQuery, request: PhaseRequest,
  tool: 'workspace-edit' | 'test-runner', argv?: string[]) {
  if (!['workspace-edit', 'test-runner'].includes(tool) || (argv !== undefined && (!Array.isArray(argv) ||
      !argv.length || !argv[0] || argv.length > 128 || argv.some(item => typeof item !== 'string' || item.includes('\0') || item.length > 8192)))) {
    throw new ProductError(422, 'invalid_workspace_action', 'Provide an authorized tool and command.');
  }
  await tx.unsafe('select id from bp_workflow_runs where project_id=$1 and id=$2 for update', [request.projectId, request.runId]);
  const phase = await resolvePhaseActivity(tx, request);
  const [receipt] = await tx.unsafe<{ requestDigest: string; state: string }>(`select request_digest as "requestDigest",state
    from bp_phase_activity_receipts where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt=$4 for update`,
  [request.projectId, request.runId, phase.occurrenceId, phase.attempt]);
  if (!receipt || receipt.state !== 'Running' || receipt.requestDigest !== contentDigest(request as unknown as JsonValue)) {
    throw new ProductError(409, 'phase_unavailable', 'The active phase claim could not be verified.');
  }
  const agent = phase.definition.agents.find(item => item.id === phase.botId);
  if (!agent?.tools.includes(tool) || phase.action.approvalRequired) throw new ProductError(403, 'tool_denied', 'This phase cannot use that workspace tool.');
  const qaRevision = await resolveQaCandidate(tx, request, phase, tool);
  const [grant] = await tx.unsafe<{ tool: string }>(`select tool_key as tool from bp_phase_workspace_grants
    where project_id=$1 and run_id=$2 and occurrence_id=$3 for share`, [request.projectId, request.runId, phase.occurrenceId]);
  if (!grant || grant.tool !== tool) throw new ProductError(409, 'workspace_tool_conflict', 'The phase is bound to a different workspace tool.');
  const [command] = await tx.unsafe<{ tool: string; digest: string }>(`select tool_key as tool,argv_digest as digest from bp_phase_workspace_commands
    where project_id=$1 and run_id=$2 and occurrence_id=$3 for share`, [request.projectId,request.runId,phase.occurrenceId]);
  if (!command || command.tool !== tool || (qaRevision && command.digest === 'legacy-unverified') ||
      (argv && command.digest !== contentDigest((qaRevision ? { argv, qaRevision } : argv) as unknown as JsonValue))) throw new ProductError(409, 'workspace_command_conflict', 'This phase is already bound to a different workspace command.');
  const result = await authorizedWorkspaceActionInTransaction(module, tx, { actor: { id: phase.actorId, role: 'user' }, projectId: request.projectId,
    assignmentId: phase.assignmentId, nativeBotId: phase.botId, actionId: phase.actionId, channelId: phase.channelId,
    operationKey: request.operationKey, tool, ...(qaRevision ? { qaRevision } : {}) }, argv);
  if (result.status !== 'completed') return result;
  if (!Number.isInteger(result.exitCode) || result.exitCode! < 0 || result.exitCode! > 255 ||
      typeof result.stdout !== 'string' || typeof result.stderr !== 'string' ||
      Buffer.byteLength(result.stdout) > 1048576 || Buffer.byteLength(result.stderr) > 1048576) {
    throw new ProductError(409, 'workspace_evidence_invalid', 'The workspace returned an invalid or oversized execution receipt.');
  }
  const evidenceId = createHash('sha256').update(JSON.stringify([request.projectId, request.runId, phase.occurrenceId, tool, request.operationKey])).digest('hex');
  const data = { exitCode: result.exitCode!, stdout: result.stdout, stderr: result.stderr, ...(qaRevision ? { qaRevision } : {}) };
  const digest = contentDigest(data);
  await tx.unsafe(`insert into bp_phase_workspace_evidence(project_id,run_id,occurrence_id,tool_key,evidence_id,exit_code,stdout,stderr,digest,qa_revision)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict do nothing`,
  [request.projectId, request.runId, phase.occurrenceId, tool, evidenceId, data.exitCode, data.stdout, data.stderr, digest, qaRevision ?? null]);
  const [stored] = await tx.unsafe<{ evidenceId: string; digest: string }>(`select evidence_id as "evidenceId",digest from bp_phase_workspace_evidence
    where project_id=$1 and run_id=$2 and occurrence_id=$3 and tool_key=$4 for share`, [request.projectId, request.runId, phase.occurrenceId, tool]);
  if (!stored || stored.evidenceId !== evidenceId || stored.digest !== digest) throw new ProductError(409, 'workspace_evidence_conflict', 'The workspace receipt changed during reconciliation.');
  return { ...result, evidenceId };
}
