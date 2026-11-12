export type ProductActor = { id: string; role: "admin" | "user" };
export type ProductPermission = "read" | "manage" | "work" | "approve" | "feedback";

export interface ProductQuery {
  unsafe<T = Record<string, unknown>>(statement: string, parameters?: unknown[]): Promise<T[]>;
}

export type Project = {
  id: string;
  installationId: string;
  blueprintKey: string;
  blueprintVersion: string;
  name: string;
  state: "Initializing" | "Operational" | "Archived";
  revision: number;
  createdBy: string;
  permissions: ProductPermission[];
};

export class ProductError extends Error {
  constructor(
    public readonly status: 403 | 404 | 409 | 422,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProductError";
  }
}

export function requirePublisher(actor: ProductActor) {
  if (actor.role !== "admin") {
    throw new ProductError(403, "publisher_required", "Blueprint publication requires an administrator.");
  }
}

export function requirePermission(project: Project, permission: ProductPermission) {
  if (!project.permissions.includes(permission)) {
    throw new ProductError(403, "project_permission_denied", "This project action is not permitted.");
  }
}

export async function requireProject(
  database: ProductQuery,
  actor: ProductActor,
  projectId: string,
  permission: ProductPermission = "read",
): Promise<Project> {
  const [project] = await database.unsafe<Project>(`
    select p.id, p.installation_id as "installationId", p.blueprint_key as "blueprintKey",
      p.blueprint_version as "blueprintVersion", p.name, p.state, p.revision,
      p.created_by as "createdBy", m.permissions
    from bp_projects p join bp_memberships m on m.project_id = p.id
    where p.id = $1 and m.user_id = $2
    for share of p, m
  `, [projectId, actor.id]);
  if (!project || !project.permissions.includes("read")) {
    throw new ProductError(404, "project_not_found", "Project not found.");
  }
  requirePermission(project, permission);
  return project;
}

export function requireOperational(project: Project) {
  if (project.state !== "Operational") {
    throw new ProductError(409, "project_not_operational", "The project must be Operational for this action.");
  }
}

/** Resolve a bot callback from the authenticated owner and native conversation. */
export async function requireBotProject(
  database: ProductQuery, actor: ProductActor, channelId: string, nativeBotId: string,
  permission: ProductPermission = "read",
) {
  const [binding] = await database.unsafe<{ projectId: string; assignmentId: string }>(`
    select c.project_id as "projectId", a.id as "assignmentId"
    from bp_conversations c
    join channel_memberships cm on cm.channel_id = c.native_channel_id and cm.user_id = $2
    join channels ch on ch.id = c.native_channel_id and ch.deleted_at is null
    join bp_assignments a on a.project_id = c.project_id and a.native_bot_id = $3
    where c.native_channel_id = $1
    for share of c, cm, ch, a
  `, [channelId, actor.id, nativeBotId]);
  if (!binding) throw new ProductError(404, "project_not_found", "Project not found.");
  const project = await requireProject(database, actor, binding.projectId, permission);
  return { project, assignmentId: binding.assignmentId };
}
