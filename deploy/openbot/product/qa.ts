import { ProductError } from "./access.js";

type Scenario = { id: string; steps: string[]; expected: string };
type Plan = { candidateRevision: string; briefRevision: string; environment: string; scenarios: Scenario[] };
type Result = { id: string; status: "passed" | "failed" | "blocked" | "not-run"; observed?: string; reason?: string; evidence?: string[] };
type Report = { candidateRevision: string; briefRevision: string; planRevision: string; environment: string; results: Result[]; verdict: string; passPercentage: number };

/** Validate exact plan coverage and compute the result; callers must resolve evidence with project permissions. */
export function validateQaReport(plan: Plan, planRevision: string, requiredScenarioIds: string[], report: Report, authorizedEvidence: ReadonlySet<string>) {
  const invalid = (message: string): never => { throw new ProductError(422, "invalid_qa_evidence", message); };
  if (!plan || !report || !planRevision || !Array.isArray(requiredScenarioIds) || !requiredScenarioIds.length ||
      requiredScenarioIds.some(id => typeof id !== "string" || !id.trim()) || new Set(requiredScenarioIds).size !== requiredScenarioIds.length) {
    return invalid("The required acceptance scenarios must have distinct identifiers.");
  }
  if (report.planRevision !== planRevision || report.candidateRevision !== plan.candidateRevision ||
      report.briefRevision !== plan.briefRevision || report.environment !== plan.environment ||
      !plan.candidateRevision || !plan.briefRevision || !plan.environment) return invalid("The report does not match its plan, candidate, brief, or environment.");
  if (!Array.isArray(plan.scenarios) || plan.scenarios.length !== requiredScenarioIds.length ||
      plan.scenarios.some(scenario => !scenario || !requiredScenarioIds.includes(scenario.id) ||
        !Array.isArray(scenario.steps) || !scenario.steps.length || scenario.steps.some(step => typeof step !== "string" || !step.trim()) ||
        typeof scenario.expected !== "string" || !scenario.expected.trim()) ||
      new Set(plan.scenarios.map(scenario => scenario.id)).size !== requiredScenarioIds.length) return invalid("The test plan must cover each required scenario exactly once with steps and an expected result.");
  if (!Array.isArray(report.results) || report.results.length !== requiredScenarioIds.length ||
      report.results.some(result => !result || !requiredScenarioIds.includes(result.id)) ||
      new Set(report.results.map(result => result.id)).size !== requiredScenarioIds.length) return invalid("The report must include exactly one result for every required scenario.");
  for (const result of report.results) {
    if (!["passed", "failed", "blocked", "not-run"].includes(result.status)) return invalid("A scenario has an invalid status.");
    const detail = result.status === "passed" || result.status === "failed" ? result.observed : result.reason;
    if (typeof detail !== "string" || !detail.trim()) return invalid("Every scenario needs an observed outcome or a reason.");
    if (result.evidence !== undefined && (!Array.isArray(result.evidence) || result.evidence.some(ref => typeof ref !== "string" || !ref || !authorizedEvidence.has(ref)))) {
      return invalid("A scenario references evidence that is unavailable or unauthorized.");
    }
  }
  const passed = report.results.filter(result => result.status === "passed").length;
  const failed = report.results.filter(result => result.status === "failed").length;
  const pending = report.results.length - passed - failed;
  const verdict = failed ? "failed" : pending ? "pending" : "passed";
  const passPercentage = passed * 100 / requiredScenarioIds.length;
  if (report.verdict !== verdict || !Number.isFinite(report.passPercentage) || Math.abs(report.passPercentage - passPercentage) > 0.000001) {
    return invalid("The reported verdict or pass percentage does not match the scenario results.");
  }
  return { verdict, passed, failed, pending, total: requiredScenarioIds.length, passPercentage };
}
