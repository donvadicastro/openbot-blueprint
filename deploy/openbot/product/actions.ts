import { ProductError } from "./access.js";
import type { BusinessAction } from "./contract/types.js";

export type ActionBinding = { projectId: string; runId: string; occurrenceId: string; assignmentId: string; actionId: string; attempt: number; runRevision: number };
export type ActionResult = ActionBinding & { status: string; outputs: { type: string; revisionId: string }[]; evidence: Record<string, string> };

/** The caller resolves authorized, immutable revisions and locks the matching run before accepting a result. */
export function validateActionResult(action: BusinessAction, expected: ActionBinding, result: ActionResult, authorizedRevisions: ReadonlyMap<string, string>, authorizedEvidence: ReadonlySet<string>) {
  const invalid = (message: string): never => { throw new ProductError(422, "invalid_action_result", message); };
  if (!result || typeof result !== "object") return invalid("A structured action result is required.");
  for (const key of ["projectId", "runId", "occurrenceId", "assignmentId", "actionId", "attempt", "runRevision"] as const) {
    if (result[key] !== expected[key]) throw new ProductError(409, "stale_action_result", "The result does not match the active project, phase, assignment, attempt, or run revision.");
  }
  if (action.id !== expected.actionId) return invalid("The action contract does not match the expected action.");
  const outcome = action.results.find(item => item.status === result.status);
  if (!outcome || !Array.isArray(result.outputs) || !result.evidence || typeof result.evidence !== "object" || Array.isArray(result.evidence)) return invalid("The result status, outputs, or evidence are invalid.");
  const types = new Set<string>(), revisions = new Set<string>();
  for (const output of result.outputs) {
    if (!output || typeof output.type !== "string" || typeof output.revisionId !== "string" || !output.revisionId ||
        !action.outputTypes.includes(output.type) || revisions.has(output.revisionId) ||
        authorizedRevisions.get(output.revisionId) !== output.type) return invalid("An output is duplicated, unavailable, unauthorized, or has the wrong type.");
    types.add(output.type); revisions.add(output.revisionId);
  }
  if (outcome.requiredOutputTypes.some(type => !types.has(type)) || outcome.requiredEvidence.some(key => typeof result.evidence[key] !== "string" || !result.evidence[key].trim())) {
    return invalid("The result is missing a required output or evidence item.");
  }
  if (Object.values(result.evidence).some(value => typeof value !== "string" || !value.trim() || !authorizedEvidence.has(value))) return invalid("Evidence items must be authorized references.");
  return outcome;
}
