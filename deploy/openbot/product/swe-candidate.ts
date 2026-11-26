import { ProductError, type ProductQuery } from './access.js';
import type { ProductModule } from './module.js';
import type { JsonValue } from './store.js';
import { authorizedWorkspaceActionInTransaction } from './workspace-actions.js';
import type { PhaseRequest } from './phase-activity.js';

type Candidate = Record<string, JsonValue>;
type Context = { actorId: string; channelId: string; assignmentId: string; botId: string; actionId: string;
  occurrenceId: string; inputRevisions: { type: string; revisionId: string }[] };

/** Check the candidate's provenance before accepting it as a phase output. */
export async function requireCandidateProvenance(tx: ProductQuery, request: PhaseRequest, phase: Context, candidate: Candidate) {
  const brief = phase.inputRevisions.find(input => input.type === 'change-brief');
  const source = phase.inputRevisions.find(input => input.type === 'source-code');
  const [vm] = await tx.unsafe<{ sourceRevision: string | null }>('select source_revision as "sourceRevision" from bp_project_vms where project_id=$1 and state=\'Ready\' for share', [request.projectId]);
  const [evidence] = await tx.unsafe<{ exitCode: number }>(`select exit_code as "exitCode" from bp_phase_workspace_evidence
    where project_id=$1 and run_id=$2 and occurrence_id=$3 and tool_key='workspace-edit' for share`,
  [request.projectId, request.runId, phase.occurrenceId]);
  if (!brief || !source || !vm?.sourceRevision || candidate.briefRevision !== brief.revisionId ||
      candidate.sourceRevision !== vm.sourceRevision || typeof candidate.revision !== 'string' ||
      !/^[a-f0-9]{40,64}$/.test(candidate.revision) || evidence?.exitCode !== 0) {
    throw new ProductError(409, 'candidate_unverified', 'The candidate must match its brief, source baseline and successful workspace operation.');
  }
}

/** Independently compare the candidate to the clean Git checkout in the isolated VM. */
export async function verifyCandidateHead(module: ProductModule, tx: ProductQuery, request: PhaseRequest, phase: Context, candidate: Candidate) {
  await requireCandidateProvenance(tx, request, phase, candidate);
  const result = await authorizedWorkspaceActionInTransaction(module, tx, {
    actor: { id: phase.actorId, role: 'user' }, projectId: request.projectId, assignmentId: phase.assignmentId,
    nativeBotId: phase.botId, actionId: phase.actionId, channelId: phase.channelId,
    tool: 'workspace-edit', operationKey: `${request.operationKey}:verify-candidate`,
  }, ['sh', '-c', 'git rev-parse HEAD && test -z "$(git status --porcelain)"']);
  if (result.status !== 'completed' || result.exitCode !== 0 || typeof result.stdout !== 'string' ||
      result.stdout.trim() !== candidate.revision) {
    throw new ProductError(409, 'candidate_unverified', 'The candidate does not match a clean workspace revision.');
  }
}
