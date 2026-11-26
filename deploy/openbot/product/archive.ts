import { requireProject, type ProductActor } from "./access.js";
import type { ProductModule } from "./module.js";

/** Archive only the project record; its conversations, artifacts and runs remain intact. */
export async function archiveProject(module: ProductModule, actor: ProductActor, projectId: string) {
  return module.database.begin(async transaction => {
    await transaction.unsafe("select pg_advisory_xact_lock(hashtextextended($1,0))", [projectId]);
    const project = await requireProject(transaction, actor, projectId, "manage");
    if (project.state === "Archived") return project;
    await transaction.unsafe("update bp_projects set state='Archived',revision=revision+1 where id=$1", [projectId]);
    return { ...project, state: "Archived" as const, revision: project.revision + 1 };
  });
}
