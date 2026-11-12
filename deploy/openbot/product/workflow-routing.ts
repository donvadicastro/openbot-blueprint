import { validateContract } from "./contract/blueprint-contract.js";
import type { Blueprint, BusinessWorkflow } from "./contract/types.js";
import { randomUUID } from "node:crypto";
import { ProductError, requireOperational, type ProductActor } from "./access.js";
import { contentDigest, type JsonValue } from "./store.js";
import type { ProductModule } from "./module.js";

export type WorkflowProposal = { workflow: BusinessWorkflow; rationale: string; guidance: string[] };

/** The Team Lead supplies its interpretation; the user does not select a workflow. */
export function selectWorkflow(blueprint: Blueprint, schema: unknown, interpretation: {
  workflowId?: string; needsClarification?: string; temporary?: WorkflowProposal;
}) {
  if (!blueprint.business) throw new ProductError(409, "blueprint_unavailable", "This blueprint does not define business workflows.");
  if (interpretation.needsClarification?.trim()) return { status: "needs-input" as const, question: interpretation.needsClarification.trim() };
  if (interpretation.workflowId) {
    const workflow = blueprint.business.workflows.find(item => item.id === interpretation.workflowId);
    if (!workflow) throw new ProductError(422, "unknown_workflow", "The selected workflow is not in this project's blueprint.");
    return { status: "selected" as const, temporary: false as const, workflow, digest: contentDigest(workflow as unknown as JsonValue), guidance: [] as string[] };
  }
  const proposal = interpretation.temporary;
  if (!proposal || typeof proposal.rationale !== "string" || !proposal.rationale.trim() || !Array.isArray(proposal.guidance)
    || !proposal.guidance.length || proposal.guidance.some(item => typeof item !== "string" || !item.trim())) {
    throw new ProductError(422, "workflow_guidance_required", "A temporary workflow needs a rationale and guidance references.");
  }
  // Until release gates are wired into the execution engine, never accept a
  // temporary plan that could dispatch an approval-protected action.
  const protectedActions = new Set(blueprint.business.actions.filter(action => action.approvalRequired).map(action => action.id));
  if (Array.isArray(proposal.workflow?.phases) && proposal.workflow.phases.some(phase => phase.action && protectedActions.has(phase.action))) {
    throw new ProductError(409, "release_gate_unavailable", "This temporary workflow requires a release approval gate that is not available yet.");
  }
  const candidate = { ...blueprint, business: { ...blueprint.business, workflows: [proposal.workflow] } };
  const failures = validateContract(candidate, schema as Parameters<typeof validateContract>[1]);
  if (failures.length) throw new ProductError(422, "invalid_workflow", failures.join("; "));
  const plan = { workflow: proposal.workflow, rationale: proposal.rationale.trim(), guidance: proposal.guidance.map(item => item.trim()) };
  return { status: "selected" as const, temporary: true as const, ...plan, digest: contentDigest(plan as unknown as JsonValue) };
}

/** Save the selected plan without dispatching until the workflow engine is available. */
export async function saveWorkflowSelection(module: ProductModule, actor: ProductActor, projectId: string, input: {
  channelId: string; request: string; interpretation: Parameters<typeof selectWorkflow>[2];
}, idempotencyKey: string, schema: unknown) {
  if (!input || typeof input.channelId !== "string" || !input.channelId || typeof input.request !== "string" || !input.request.trim()
    || !input.interpretation || typeof input.interpretation !== "object" || Array.isArray(input.interpretation)) {
    throw new ProductError(422, "invalid_request", "A conversation and request are required.");
  }
  return module.store.mutate<Record<string, JsonValue>>(actor, projectId, "work", idempotencyKey, input as unknown as JsonValue, async (transaction, project): Promise<Record<string, JsonValue>> => {
    requireOperational(project);
    const [channel] = await transaction.unsafe<{ id: string }>(`
      select c.native_channel_id as id from bp_conversations c
      join channel_memberships m on m.channel_id=c.native_channel_id and m.user_id=$3
      join channels ch on ch.id=c.native_channel_id and ch.deleted_at is null
      where c.project_id=$1 and c.native_channel_id=$2 for share of c, m, ch
    `, [projectId, input.channelId, actor.id]);
    if (!channel) throw new ProductError(404, "conversation_not_found", "Conversation not found.");
    const definition = await module.definitionFor(project);
    const selection = selectWorkflow(definition, schema, input.interpretation);
    if (selection.status === "needs-input") return { status: "needs-input", question: selection.question };
    const initial = selection.workflow.phases.find(phase => phase.id === selection.workflow.startPhase);
    const action = definition.business?.actions.find(item => item.id === initial?.action);
    if (!action) throw new ProductError(422, "workflow_start_unavailable", "The workflow does not start with an assigned action.");
    const [assignment] = await transaction.unsafe<{ id: string }>(
      'select id from bp_assignments where project_id=$1 and role_key=$2 for share', [projectId, action.role],
    );
    if (!assignment) throw new ProductError(409, "assignment_unavailable", "The specialist for the first phase is not assigned.");
    const itemId = randomUUID(), runId = randomUUID(), occurrenceId = randomUUID();
    const plan = { workflow: selection.workflow, guidance: selection.guidance, ...(selection.temporary ? { rationale: selection.rationale } : {}) };
    await transaction.unsafe('insert into bp_work_items(project_id,id,native_channel_id,requested_by,request) values($1,$2,$3,$4,$5)',
      [projectId, itemId, channel.id, actor.id, input.request.trim()]);
    await transaction.unsafe(`insert into bp_workflow_runs(project_id,id,work_item_id,blueprint_key,blueprint_version,workflow_key,plan_digest,plan,current_phase,state)
      values($1,$2,$3,$4,$5,$6,$7,$8::text::jsonb,$9,'Pending')`,
      [projectId, runId, itemId, project.blueprintKey, project.blueprintVersion, selection.temporary ? null : selection.workflow.id,
        contentDigest(plan as unknown as JsonValue), JSON.stringify(plan), selection.workflow.startPhase]);
    const operationKey = `${runId}:1`;
    await transaction.unsafe(`insert into bp_phase_occurrences(project_id,run_id,id,phase_key,occurrence,action_key,assignment_id,operation_key)
      values($1,$2,$3,$4,1,$5,$6,$7)`, [projectId, runId, occurrenceId, selection.workflow.startPhase, action.id, assignment.id, operationKey]);
    await transaction.unsafe("insert into bp_action_attempts(project_id,run_id,occurrence_id,attempt,state) values($1,$2,$3,1,'Pending')", [projectId, runId, occurrenceId]);
    await transaction.unsafe("insert into bp_dispatch_intents(project_id,run_id,occurrence_id,attempt,operation_key,state) values($1,$2,$3,1,$4,'Pending')", [projectId, runId, occurrenceId, operationKey]);
    return { status: "saved" as const, itemId, runId, temporary: selection.temporary };
  });
}
