import { ProductError, type ProductQuery } from "./access.js";
import { contentDigest, roleMayReadArtifact, type JsonValue } from "./store.js";
import type { BusinessAction, BusinessContract } from "./contract/types.js";

/** Pin authorized initial inputs or prior outputs from the same workflow run. */
export async function resolveWorkflowInputs(tx: ProductQuery, projectId: string, runId: string | null,
  actorId: string, business: BusinessContract, roleId: string, action: BusinessAction) {
  const inputs: { type: string; revisionId: string }[] = [];
  for (const typeKey of action.inputTypes) {
    const type = business.artifactTypes.find(item => item.id === typeKey);
    if (!roleMayReadArtifact(type, roleId)) throw new ProductError(403, 'input_denied', 'The specialist cannot read a required input.');
    const initial = [...business.initialization.requiredArtifacts, ...business.initialization.recommendedArtifacts].includes(typeKey);
    const [revision] = await tx.unsafe<{ id: string; digest: string; payload: JsonValue }>(`select r.id,r.digest,r.payload from bp_artifacts a
      join bp_artifact_revisions r on r.project_id=a.project_id and r.artifact_id=a.id
      where a.project_id=$1 and a.type_key=$2 and a.status='supplied' and (a.allowed_user_ids is null or $3=any(a.allowed_user_ids))
        and not exists (select 1 from bp_artifact_revisions newer where newer.project_id=r.project_id and newer.artifact_id=r.artifact_id
          and (newer.created_at,newer.id)>(r.created_at,r.id))
        and (($4::boolean and a.id=a.type_key) or exists (select 1 from bp_phase_results pr,
          jsonb_array_elements(pr.result->'outputs') output where pr.project_id=a.project_id and pr.run_id=$5
            and output->>'type'=a.type_key and output->>'revisionId'=r.id))
      order by r.created_at desc,r.id desc limit 1 for share of a,r`, [projectId, typeKey, actorId, initial, runId]);
    if (!revision || contentDigest(revision.payload) !== revision.digest) throw new ProductError(409, 'input_unavailable', `The specialist needs an authorized ${typeKey} input.`);
    inputs.push({ type: typeKey, revisionId: revision.id });
  }
  return inputs;
}
