import { ProductError, requireProject, type ProductActor, type ProductQuery } from './access.js';
import { contentDigest, type JsonValue } from './store.js';
import { requireReleaseInputs } from './release-preflight.js';

/** Record an authorized decision on exactly the currently valid release proposal. */
export async function recordReleaseApproval(tx: ProductQuery, actor: ProductActor, projectId: string, runId: string, decisionId: string, value: string) {
  if (value !== 'approve' && value !== 'reject') throw new ProductError(422, 'invalid_decision', 'Choose approve or reject.');
  const project = await requireProject(tx, actor, projectId, 'approve');
  const [row] = await tx.unsafe<{ proposalId: string; state: string; evidence: Record<string, JsonValue>; candidateArtifactId: string;
    candidateRevisionId: string; target: string; planDigest: string; phase: string; occurrence: number; operationKey: string }>(`
    select p.id as "proposalId",p.state,p.evidence,p.candidate_artifact_id as "candidateArtifactId",p.candidate_revision_id as "candidateRevisionId",p.target,
      r.plan_digest as "planDigest",o.phase_key as phase,o.occurrence,o.operation_key as "operationKey"
    from bp_release_decision_bindings link join bp_release_proposals p on (p.project_id,p.run_id,p.id)=(link.project_id,link.run_id,link.proposal_id)
    join bp_phase_decision_bindings b on (b.project_id,b.run_id,b.decision_id)=(link.project_id,link.run_id,link.decision_id)
    join bp_phase_occurrences o on (o.project_id,o.run_id,o.id)=(b.project_id,b.run_id,b.occurrence_id)
    join bp_workflow_runs r on (r.project_id,r.id)=(o.project_id,o.run_id)
    join bp_work_items w on (w.project_id,w.id)=(r.project_id,r.work_item_id)
    join bp_conversations c on c.project_id=w.project_id and c.native_channel_id=w.native_channel_id
    join channel_memberships cm on cm.channel_id=c.native_channel_id and cm.user_id=$4
    join channels ch on ch.id=c.native_channel_id and ch.deleted_at is null
    where link.project_id=$1 and link.run_id=$2 and link.decision_id=$3 for update of p for share of link,b,o,r,w,c,cm,ch`,
  [projectId,runId,decisionId,actor.id]);
  if (!row || row.state !== 'Pending') throw new ProductError(409, 'release_decision_unavailable', 'The release proposal is unavailable.');
  const evidenceTypes = [['candidateRevision','candidate'],['qaEvidenceRevision','qa-evidence'],['briefRevision','change-brief'],
    ['planRevision','test-plan'],['runbookRevision','release-runbook'],['targetRevision','release-target']] as const;
  for (const [field,type] of evidenceTypes) {
    const revision = row.evidence?.[field];
    if (typeof revision !== 'string') throw new ProductError(409, 'release_evidence_unavailable', 'The release evidence is unavailable.');
    const [visible] = await tx.unsafe(`select 1 from bp_artifact_revisions r join bp_artifacts a on (a.project_id,a.id)=(r.project_id,r.artifact_id)
      where r.project_id=$1 and r.id=$2 and a.type_key=$3 and a.status='supplied'
        and (a.allowed_user_ids is null or $4=any(a.allowed_user_ids)) for share of a,r`, [projectId,revision,type,actor.id]);
    if (!visible) throw new ProductError(404, 'decision_not_found', 'Decision not found.');
  }
  const current = await requireReleaseInputs(tx, { installationId: project.installationId, projectId, runId,
    planDigest: row.planDigest, phase: row.phase, occurrence: row.occurrence, operationKey: row.operationKey });
  if (contentDigest(row.evidence) !== contentDigest(current as unknown as JsonValue) || row.candidateRevisionId !== current.candidateRevision || row.target !== current.target) {
    throw new ProductError(409, 'release_evidence_unavailable', 'The release evidence changed before the decision.');
  }
  const decision = value === 'approve' ? 'Approved' : 'Rejected';
  await tx.unsafe(`insert into bp_release_approvals(project_id,run_id,proposal_id,id,candidate_artifact_id,candidate_revision_id,target,approver_id,decision)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [projectId,runId,row.proposalId,decisionId,row.candidateArtifactId,row.candidateRevisionId,row.target,actor.id,decision]);
  await tx.unsafe('update bp_release_proposals set state=$4 where project_id=$1 and run_id=$2 and id=$3', [projectId,runId,row.proposalId,decision]);
}
