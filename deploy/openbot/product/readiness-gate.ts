import { ProductError, type ProductQuery, type Project } from "./access.js";
import { workspaceCall } from "./workspace.js";

type BusinessReadiness = { roles: { id: string }[]; initialization: { workspace: { kind: string } } };

/** Call with the project and its actor membership locked for the transaction. */
export async function requireReadyReports(transaction: ProductQuery, projectId: string, roles: { id: string }[]) {
  const reports = await transaction.unsafe<{ roleKey: string; revision: number; reportedRevision: number; status: string }>(`
    select a.role_key as "roleKey",a.revision,r.assignment_revision as "reportedRevision",r.status
    from bp_assignments a join bp_readiness r on r.project_id=a.project_id and r.assignment_id=a.id
    where a.project_id=$1 for share of a,r`, [projectId]);
  if (reports.length !== roles.length || roles.some(role => !reports.some(report =>
    report.roleKey === role.id && report.revision === report.reportedRevision && report.status === "Ready"))) {
    throw new ProductError(409, "readiness_stale", "The project team must complete current readiness checks before work starts.");
  }
}

/** Recheck the live VM and exact source before accepting or dispatching work. */
export async function requireReadyWorkspace(transaction: ProductQuery, project: Pick<Project, "id" | "installationId">, business: BusinessReadiness) {
  if (business.initialization.workspace.kind !== "vm") return;
  const [vm] = await transaction.unsafe<{ providerId: string | null; sourceRevision: string | null; state: string }>(
    'select provider_id as "providerId",source_revision as "sourceRevision",state from bp_project_vms where project_id=$1 for share', [project.id],
  );
  if (!vm?.providerId || !vm.sourceRevision || vm.state !== "Ready") throw new ProductError(409, "workspace_unavailable", "The project workspace is unavailable.");
  const binding = { installationId: project.installationId, projectId: project.id };
  const health = await workspaceCall("check", binding);
  if (!health.ready || !health.isolated || health.id !== vm.providerId) throw new ProductError(409, "workspace_unavailable", "The project workspace or its isolation is unavailable.");
  const source = await workspaceCall("source", binding);
  if (!source.hasProject || source.revision !== vm.sourceRevision) throw new ProductError(409, "workspace_unavailable", "The project workspace source is not current.");
}
