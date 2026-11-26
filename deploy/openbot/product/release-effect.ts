import { createHash } from 'node:crypto';
import { ProductError, type ProductQuery } from './access.js';
import { contentDigest, type JsonValue } from './store.js';
import type { PhaseRequest } from './phase-activity.js';
import { requireReleaseInputs } from './release-preflight.js';

/** Recheck the exact approved proposal and the approver's current authority. */
export async function requireApprovedRelease(tx: ProductQuery, request: PhaseRequest) {
  const invalid = () => new ProductError(409, 'release_approval_unavailable', 'A current, authorized approval of this exact release is required.');
  if (request.phase !== 'deploy') throw invalid();
  const current = await requireReleaseInputs(tx, request);
  const rows = await tx.unsafe<{ proposalId: string; candidateRevision: string; target: string; evidence: JsonValue; decision: string; approverId: string }>(`
    select p.id as "proposalId",p.candidate_revision_id as "candidateRevision",p.target,p.evidence,a.decision,a.approver_id as "approverId"
    from bp_release_proposals p join bp_release_decision_bindings link on (link.project_id,link.run_id,link.proposal_id)=(p.project_id,p.run_id,p.id)
    join bp_workflow_decisions d on (d.project_id,d.run_id,d.id)=(link.project_id,link.run_id,link.decision_id)
    join bp_release_approvals a on (a.project_id,a.run_id,a.proposal_id,a.id)=(p.project_id,p.run_id,p.id,d.id) and a.approver_id=d.answered_by
    join bp_phase_decision_bindings b on (b.project_id,b.run_id,b.decision_id)=(d.project_id,d.run_id,d.id)
    join bp_phase_occurrences prepared on (prepared.project_id,prepared.run_id,prepared.id)=(b.project_id,b.run_id,b.occurrence_id)
      and prepared.phase_key='prepare-release' and prepared.action_key='prepare-release'
    join bp_phase_occurrences deployment on deployment.project_id=prepared.project_id and deployment.run_id=prepared.run_id
      and deployment.phase_key='deploy' and deployment.action_key='deploy' and deployment.occurrence=prepared.occurrence+1
      and deployment.occurrence=$3 and deployment.operation_key=$4
    join bp_phase_activity_receipts receipt on (receipt.project_id,receipt.run_id,receipt.occurrence_id,receipt.attempt)=(b.project_id,b.run_id,b.occurrence_id,b.attempt)
    join bp_workflow_runs run on (run.project_id,run.id)=(p.project_id,p.run_id)
    join bp_work_items item on (item.project_id,item.id)=(run.project_id,run.work_item_id)
    join bp_memberships m on m.project_id=p.project_id and m.user_id=a.approver_id
    join bp_conversations c on c.project_id=item.project_id and c.native_channel_id=item.native_channel_id
    join channel_memberships cm on cm.channel_id=c.native_channel_id and cm.user_id=a.approver_id
    join channels ch on ch.id=c.native_channel_id and ch.deleted_at is null
    where p.project_id=$1 and p.run_id=$2 and p.state='Approved' and a.decision='Approved' and d.state='Answered' and d.answer='"approve"'::jsonb
      and receipt.state='Completed' and receipt.outcome->>'kind'='advance' and receipt.outcome->>'nextPhase'='deploy'
      and 'read'=any(m.permissions) and 'approve'=any(m.permissions)
      and not exists (select 1 from (values ('candidateRevision','candidate'),('qaEvidenceRevision','qa-evidence'),
        ('briefRevision','change-brief'),('planRevision','test-plan'),('runbookRevision','release-runbook'),('targetRevision','release-target')) refs(field,type)
        where not exists (select 1 from bp_artifact_revisions ar join bp_artifacts artifact on (artifact.project_id,artifact.id)=(ar.project_id,ar.artifact_id)
          where ar.project_id=p.project_id and ar.id=p.evidence->>refs.field and artifact.type_key=refs.type and artifact.status='supplied'
            and (artifact.allowed_user_ids is null or a.approver_id=any(artifact.allowed_user_ids))))
    for share of p,link,d,a,b,prepared,deployment,receipt,run,item,m,c,cm,ch`, [request.projectId,request.runId,request.occurrence,request.operationKey]);
  if (rows.length !== 1 || contentDigest(rows[0].evidence) !== contentDigest(current as unknown as JsonValue) ||
      rows[0].candidateRevision !== current.candidateRevision || rows[0].target !== current.target) throw invalid();
  const operationId = createHash('sha256').update(JSON.stringify([request.projectId,request.runId,rows[0].proposalId])).digest('hex');
  return { ...current, proposalId: rows[0].proposalId, approverId: rows[0].approverId, operationId };
}

/** Deployment records can only describe a verified receipt for this approval. */
export async function requireDeploymentOutput(tx: ProductQuery, request: PhaseRequest, payload: Record<string, JsonValue>) {
  const invalid = () => new ProductError(409, 'deployment_evidence_unavailable', 'A verified receipt for the approved deployment is required.');
  const binding = await requireApprovedRelease(tx, request);
  const [effect] = await tx.unsafe<{ state: string; receipt: Record<string, JsonValue> | null; verification: Record<string, JsonValue> | null; boundTarget: string; origin: string }>(`
    select e.state,e.receipt,e.verification,b.target_id as "boundTarget",b.endpoint_origin as origin from bp_release_effects e
    join bp_release_target_bindings b on (b.project_id,b.run_id,b.proposal_id)=(e.project_id,e.run_id,e.proposal_id)
    where e.project_id=$1 and e.run_id=$2 and e.proposal_id=$3 and e.operation_key=$4 for share of e,b`,
  [request.projectId,request.runId,binding.proposalId,binding.operationId]);
  const receipt = effect?.receipt, verification = effect?.verification;
  if (effect?.state !== 'Confirmed' || effect.boundTarget !== binding.target || !effect.origin || !receipt || !verification || receipt.operationId !== binding.operationId || receipt.projectId !== request.projectId ||
      receipt.candidateDigest !== binding.candidateCommit || receipt.target !== binding.target || typeof receipt.receiptId !== 'string' || !receipt.receiptId ||
      verification.status !== 'verified' || typeof verification.verificationId !== 'string' || !verification.verificationId ||
      !verification.receipt || typeof verification.receipt !== 'object' || Array.isArray(verification.receipt) ||
      contentDigest(verification.receipt) !== contentDigest(receipt) || payload.candidateRevision !== binding.candidateRevision ||
      payload.target !== binding.target || payload.receipt !== receipt.receiptId || payload.verified !== true) throw invalid();
}
