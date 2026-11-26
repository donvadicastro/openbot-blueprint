import { ProductError } from "./access.js";
import type { BusinessAction, BusinessWorkflow } from "./contract/types.js";

export type ActionBinding = { projectId: string; runId: string; occurrenceId: string; assignmentId: string; actionId: string; attempt: number; runRevision: number };
export type ActionResult = ActionBinding & {
  status: string;
  outputs: { type: string; revisionId: string }[];
  evidence: Record<string, string>;
  question?: string;
  reason?: string;
};

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
  if (result.status === "needs-input") {
    if (typeof result.question !== "string" || !result.question.trim() || result.question.length > 4000 ||
        result.outputs.length || Object.keys(result.evidence).length) {
      return invalid("A clarification needs one bounded question before any completed output or effect.");
    }
  } else if (result.question !== undefined) {
    return invalid("Only a clarification may include a question.");
  }
  // A failed turn may be retried by policy, so its reason is optional. A
  // blocked turn stops the run and must say why. Either way a supplied reason
  // must be bounded and non-blank.
  if (result.reason !== undefined && (typeof result.reason !== "string" || !result.reason.trim() || result.reason.length > 4000)) {
    return invalid("A failure reason of 1 to 4000 characters is required.");
  }
  if (result.status === "blocked" && result.reason === undefined) {
    return invalid("A blocked result needs a failure reason of 1 to 4000 characters.");
  }
  if (result.status !== "failed" && result.status !== "blocked" && result.reason !== undefined) {
    return invalid("A failure reason is only accepted for a failed or blocked outcome.");
  }
  const revisions = new Set<string>();
  for (const output of result.outputs) {
    if (!output || typeof output.type !== "string" || typeof output.revisionId !== "string" || !output.revisionId ||
        !action.outputTypes.includes(output.type) || revisions.has(output.revisionId) ||
        authorizedRevisions.get(output.revisionId) !== output.type) return invalid("An output is duplicated, unavailable, unauthorized, or has the wrong type.");
    revisions.add(output.revisionId);
  }
  const types = new Set(result.outputs.map(output => output.type));
  if (types.size !== result.outputs.length) return invalid("An output is duplicated, unavailable, unauthorized, or has the wrong type.");
  if (outcome.requiredOutputTypes.some(type => !types.has(type)) || outcome.requiredEvidence.some(key => typeof result.evidence[key] !== "string" || !result.evidence[key].trim())) {
    return invalid("The result is missing a required output or evidence item.");
  }
  if (Object.values(result.evidence).some(value => typeof value !== "string" || !value.trim() || !authorizedEvidence.has(value))) return invalid("Evidence items must be authorized references.");
  return outcome;
}

/** Select the single workflow transition that matches the result, its records and an optional decision. */
export function selectActionTransition(
  workflow: BusinessWorkflow,
  from: string,
  status: string,
  records: ReadonlyMap<string, Record<string, unknown>>,
  decision?: string,
): string | null {
  const resolves = (transition: BusinessWorkflow["transitions"][number]) => {
    const { recordType, field, equals } = transition.when;
    if (recordType === undefined && field === undefined && equals === undefined) return true;
    if (!recordType || !field || equals === undefined) return false;
    const payload = records.get(recordType);
    if (!payload || typeof payload !== "object") return false;
    const value = field.split(".").reduce<unknown>((current, key) =>
      current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined, payload);
    return value === equals;
  };
  const matches = workflow.transitions.filter(transition => transition.from === from && transition.when.status === status &&
    (transition.when.decision === undefined || transition.when.decision === decision) && resolves(transition));
  if (matches.length > 1) throw new ProductError(409, "workflow_plan_invalid", "The workflow has more than one matching transition.");
  return matches[0]?.to ?? null;
}
