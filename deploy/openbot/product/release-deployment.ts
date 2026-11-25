import { ProductError, type ProductQuery } from './access.js';
import type { ProductModule } from './module.js';
import { claimPhaseActivity, resolvePhaseActivity, type PhaseRequest } from './phase-activity.js';
import { requireApprovedRelease } from './release-effect.js';
import { createStagingTarget, type StagingOperation, type StagingReceipt } from './staging-target.js';
import { savePhaseOutput } from './phase-output.js';
import { recordPhaseResult } from './phase-result.js';
import { applyPhaseResult } from './phase-transition.js';
import type { ActionResult } from './actions.js';
import type { PhaseOutcome } from './workflow-activity-routes.js';
import { contentDigest, type JsonValue } from './store.js';

const held = (reason: string): PhaseOutcome => ({ kind: 'uncertain', reason });
type Config = { id: string; origin: string; target: ReturnType<typeof createStagingTarget> };
function stagingConfig(): Config | undefined {
  const { STAGING_TARGET_URL: endpoint, STAGING_TARGET_TOKEN: token, STAGING_TARGET_ID: id } = process.env;
  if (!endpoint || !token || !id || id !== id.trim() || id.length > 300) return undefined;
  try { return { id, origin: new URL(endpoint).origin, target: createStagingTarget(endpoint, token) }; } catch { return undefined; }
}
async function lockedProof(tx: ProductQuery, request: PhaseRequest, config: Config, requireClaim = false) {
  await tx.unsafe('select id from bp_workflow_runs where project_id=$1 and id=$2 for update', [request.projectId,request.runId]);
  const binding = await requireApprovedRelease(tx, request);
  if (binding.target !== config.id) throw new ProductError(409, 'release_target_unavailable', 'The approved target is not the configured disposable staging target.');
  if (requireClaim) {
    const [claim] = await tx.unsafe<{ state: string; digest: string }>(`select receipt.state,receipt.request_digest as digest from bp_phase_activity_receipts receipt
      join bp_phase_occurrences occurrence on (occurrence.project_id,occurrence.run_id,occurrence.id)=(receipt.project_id,receipt.run_id,receipt.occurrence_id)
      where occurrence.project_id=$1 and occurrence.run_id=$2 and occurrence.phase_key=$3 and occurrence.occurrence=$4 and occurrence.operation_key=$5
        and receipt.attempt=(select max(a.attempt) from bp_action_attempts a where (a.project_id,a.run_id,a.occurrence_id)=(receipt.project_id,receipt.run_id,receipt.occurrence_id))
      for update of receipt`, [request.projectId,request.runId,request.phase,request.occurrence,request.operationKey]);
    if (!claim || claim.state !== 'Running' || claim.digest !== contentDigest(request as unknown as JsonValue)) throw new ProductError(409, 'phase_unavailable', 'The active deployment claim is unavailable.');
  }
  const operation: StagingOperation = { operationId: binding.operationId, projectId: request.projectId, candidateDigest: binding.candidateCommit, target: binding.target };
  return { binding, operation };
}
type Effect = { state: string; receipt: StagingReceipt | null; verification: Record<string, unknown> | null };
async function effectForUpdate(tx: ProductQuery, request: PhaseRequest, proposalId: string, operationId: string) {
  const [effect] = await tx.unsafe<Effect>(`select state,receipt,verification from bp_release_effects
    where project_id=$1 and run_id=$2 and proposal_id=$3 and operation_key=$4 for update`, [request.projectId,request.runId,proposalId,operationId]);
  return effect;
}
async function requireTargetBinding(tx: ProductQuery, request: PhaseRequest, proposalId: string, config: Config, create = false) {
  if (create) await tx.unsafe(`insert into bp_release_target_bindings(project_id,run_id,proposal_id,target_id,endpoint_origin)
    values($1,$2,$3,$4,$5)`, [request.projectId,request.runId,proposalId,config.id,config.origin]);
  const [binding] = await tx.unsafe<{ id: string; origin: string }>(`select target_id as id,endpoint_origin as origin from bp_release_target_bindings
    where project_id=$1 and run_id=$2 and proposal_id=$3 for share`, [request.projectId,request.runId,proposalId]);
  if (!binding || binding.id !== config.id || binding.origin !== config.origin) throw new ProductError(409, 'release_target_changed', 'The staging service binding changed; the operation must remain held.');
}
async function reserve(module: ProductModule, request: PhaseRequest, config: Config) {
  return module.database.begin(async tx => {
    const { binding, operation } = await lockedProof(tx, request, config, true);
    const [created] = await tx.unsafe(`insert into bp_release_effects(project_id,run_id,proposal_id,operation_key,state)
      values($1,$2,$3,$4,'Pending') on conflict do nothing returning proposal_id`, [request.projectId,request.runId,binding.proposalId,binding.operationId]);
    const effect = await effectForUpdate(tx, request, binding.proposalId, binding.operationId);
    if (!effect) throw new ProductError(409, 'release_effect_conflict', 'The release operation is bound elsewhere.');
    await requireTargetBinding(tx, request, binding.proposalId, config, Boolean(created));
    if (effect.state !== 'Pending' || effect.receipt) return { dispatch: false, operation };
    await tx.unsafe("update bp_release_effects set state='Dispatching',updated_at=now() where project_id=$1 and run_id=$2 and proposal_id=$3", [request.projectId,request.runId,binding.proposalId]);
    return { dispatch: true, operation };
  });
}
async function dispatch(module: ProductModule, request: PhaseRequest, config: Config) {
  return module.database.begin(async tx => {
    const { binding, operation } = await lockedProof(tx, request, config, true);
    const effect = await effectForUpdate(tx, request, binding.proposalId, binding.operationId);
    if (!effect || effect.state !== 'Dispatching' || effect.receipt) return false;
    await requireTargetBinding(tx, request, binding.proposalId, config);
    const result = await config.target.deploy(operation);
    await tx.unsafe(`update bp_release_effects set state='Uncertain',receipt=$4::text::jsonb,updated_at=now()
      where project_id=$1 and run_id=$2 and proposal_id=$3`, [request.projectId,request.runId,binding.proposalId,result.status === 'confirmed' ? JSON.stringify(result.receipt) : null]);
    return result.status === 'confirmed';
  });
}
async function verifyAndFinish(module: ProductModule, request: PhaseRequest, config: Config): Promise<PhaseOutcome> {
  return module.database.begin(async tx => {
    const { binding } = await lockedProof(tx, request, config, true);
    const effect = await effectForUpdate(tx, request, binding.proposalId, binding.operationId);
    if (!effect?.receipt) return held('The staging receipt is not confirmed; reconcile the release before continuing.');
    await requireTargetBinding(tx, request, binding.proposalId, config);
    const verified = effect.state === 'Confirmed' && effect.verification ? effect.verification : await config.target.verify(effect.receipt);
    if (verified.status !== 'verified') return held('The staging receipt is recorded, but post-deployment verification is not confirmed.');
    if (effect.state !== 'Confirmed') await tx.unsafe(`update bp_release_effects set state='Confirmed',verification=$4::text::jsonb,updated_at=now()
      where project_id=$1 and run_id=$2 and proposal_id=$3`, [request.projectId,request.runId,binding.proposalId,JSON.stringify(verified)]);
    const phase = await resolvePhaseActivity(tx, request);
    const output = await savePhaseOutput(tx, request, 'deployment-evidence', { candidateRevision: binding.candidateRevision,
      target: binding.target, receipt: effect.receipt.receiptId, verified: true });
    const result: ActionResult = { projectId: request.projectId, runId: request.runId, occurrenceId: phase.occurrenceId,
      assignmentId: phase.assignmentId, actionId: phase.actionId, attempt: phase.attempt, runRevision: phase.runRevision,
      status: 'succeeded', outputs: [{ type: 'deployment-evidence', revisionId: output.revisionId }], evidence: { result: output.revisionId } };
    await recordPhaseResult(tx, request, result, module);
    return await applyPhaseResult(tx, request, result) as PhaseOutcome;
  });
}

/** Reserve and commit the operation key before sending any staging effect. */
export async function executeReleaseDeployment(module: ProductModule, request: PhaseRequest): Promise<PhaseOutcome> {
  const config = stagingConfig();
  if (!config) return held('The disposable staging target is not configured.');
  try {
    const binding = await module.database.begin(tx => lockedProof(tx, request, config));
    if (binding.binding.target !== config.id) return held('The approved target is not the configured staging target.');
    const claim = await module.database.begin(tx => claimPhaseActivity(tx, request));
    if (claim.status === 'completed') return claim.outcome as PhaseOutcome;
    if (claim.status !== 'claimed') return held('The deployment was already started; reconcile it before continuing.');
    const reservation = await reserve(module, request, config);
    if (!reservation.dispatch) return held('The deployment has a prior operation; reconcile it before continuing.');
    if (!await dispatch(module, request, config)) return held('The staging effect was not confirmed; reconcile it before continuing.');
    return await verifyAndFinish(module, request, config);
  } catch { return held('The approved deployment could not be confirmed; reconcile it before continuing.'); }
}

/** A lost response is resolved by operation ID before any repeat dispatch. */
export async function reconcileReleaseDeployment(module: ProductModule, request: PhaseRequest): Promise<PhaseOutcome> {
  const config = stagingConfig();
  if (!config) return held('The disposable staging target is not configured.');
  try {
    const lookup = await module.database.begin(async tx => {
      const { binding, operation } = await lockedProof(tx, request, config, true);
      let effect = await effectForUpdate(tx, request, binding.proposalId, binding.operationId);
      if (!effect) {
        await tx.unsafe(`insert into bp_release_effects(project_id,run_id,proposal_id,operation_key,state) values($1,$2,$3,$4,'Dispatching')`, [request.projectId,request.runId,binding.proposalId,binding.operationId]);
        await requireTargetBinding(tx, request, binding.proposalId, config, true);
        return 'dispatch' as const;
      }
      await requireTargetBinding(tx, request, binding.proposalId, config);
      if (effect.receipt) return 'verify' as const;
      const found = await config.target.lookup(operation);
      if (found.status === 'uncertain') return 'uncertain' as const;
      if (found.status === 'confirmed') {
        await tx.unsafe(`update bp_release_effects set state='Uncertain',receipt=$4::text::jsonb,updated_at=now() where project_id=$1 and run_id=$2 and proposal_id=$3`, [request.projectId,request.runId,binding.proposalId,JSON.stringify(found.receipt)]);
        return 'verify' as const;
      }
      await tx.unsafe("update bp_release_effects set state='Dispatching',updated_at=now() where project_id=$1 and run_id=$2 and proposal_id=$3", [request.projectId,request.runId,binding.proposalId]);
      return 'dispatch' as const;
    });
    if (lookup === 'uncertain') return held('The staging effect is still uncertain; reconcile it before continuing.');
    if (lookup === 'dispatch' && !await dispatch(module, request, config)) return held('The staging effect was not confirmed; reconcile it before continuing.');
    return await verifyAndFinish(module, request, config);
  } catch { return held('The approved deployment could not be reconciled.'); }
}
