import { ProductError, type ProductActor, type ProductQuery } from "./access.js";
import { requireNativeBotContext, type VerifiedNativeRun } from "./native-context.js";

/** Resolve a dispatcher-created run binding; tool arguments cannot select any of it. */
export async function requireNativeWorkspaceAction(transaction: ProductQuery, actor: ProductActor, nativeRun: VerifiedNativeRun) {
  if (typeof nativeRun.runId !== "string" || !nativeRun.runId || nativeRun.runId.length > 200) {
    throw new ProductError(404, "action_not_found", "No active workspace action is available.");
  }
  const [owned] = await transaction.unsafe<{ assignmentId: string }>(
    'select assignment_id as "assignmentId" from bp_native_action_runs where native_run_id=$1 and actor_id=$2 for share',
    [nativeRun.runId, actor.id],
  );
  if (!owned) throw new ProductError(404, "action_not_found", "No active workspace action is available.");
  const context = await requireNativeBotContext(transaction, actor, nativeRun, "work", owned.assignmentId);
  const [binding] = await transaction.unsafe<{
    actionId: string; assignmentId: string; operationKey: string; tool: "workspace-edit" | "test-runner";
  }>(`
    select o.action_key as "actionId",o.assignment_id as "assignmentId",o.operation_key as "operationKey",b.tool_key as tool
    from bp_native_action_runs b
    join bp_workflow_runs r on r.project_id=b.project_id and r.id=b.run_id
    join bp_phase_occurrences o on o.project_id=b.project_id and o.run_id=b.run_id and o.id=b.occurrence_id
    join bp_action_attempts a on a.project_id=b.project_id and a.run_id=b.run_id and a.occurrence_id=b.occurrence_id and a.attempt=b.attempt
    join bp_dispatch_intents d on d.project_id=a.project_id and d.run_id=a.run_id and d.occurrence_id=a.occurrence_id and d.attempt=a.attempt
    where b.project_id=$1 and b.native_run_id=$2 and b.actor_id=$3 and b.assignment_id=$4
      and o.assignment_id=b.assignment_id and r.current_phase=o.phase_key and r.state='Running'
      and a.state='Running' and d.state='Dispatched' and d.operation_key=o.operation_key
    for share of b,r,o,a,d
  `, [context.project.id, nativeRun.runId, actor.id, context.assignmentId]);
  if (!binding) throw new ProductError(404, "action_not_found", "No active workspace action is available.");
  return { ...context, ...binding };
}
