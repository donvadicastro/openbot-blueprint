import { randomUUID } from "node:crypto";
import { ProductError, requireProject, type ProductActor } from "./access.js";
import type { ProductModule } from "./module.js";
import { contentDigest } from "./store.js";

type Source = { conversationId: string; messageId: string };
type Memory = { id: string; revision: number; guidance: string; source: Source; authorId: string; createdAt: string };
export type FeedbackTranscript = (threadId: string, userId: string, messageId: string) => Promise<boolean>;

/** Corrections must identify the exact version they replace; ambiguous conflicts stay unresolved. */
export async function recordGuidance(module: ProductModule, actor: ProductActor, projectId: string, assignmentId: string,
  input: { guidance: string; source: Source; entryId?: string; expectedRevision?: number }, idempotencyKey: string, transcript?: FeedbackTranscript) {
  if (typeof input.guidance !== "string" || !input.guidance.trim() || input.guidance.length > 4000 ||
      !input.source || typeof input.source.conversationId !== "string" || typeof input.source.messageId !== "string" ||
      !input.source.conversationId || input.source.conversationId.length > 200 || !input.source.messageId || input.source.messageId.length > 200 ||
      Object.keys(input.source).some(key => key !== "conversationId" && key !== "messageId") ||
      (input.entryId !== undefined && (typeof input.entryId !== "string" || !input.entryId || input.entryId.length > 200 || !Number.isInteger(input.expectedRevision) || input.expectedRevision! < 1)) ||
      (input.entryId === undefined && input.expectedRevision !== undefined)) {
    throw new ProductError(422, "invalid_feedback", "Provide guidance and its conversation and message, and identify the current revision for a correction.");
  }
  if (typeof idempotencyKey !== "string" || !idempotencyKey.length || idempotencyKey.length > 200) {
    throw new ProductError(422, "invalid_idempotency_key", "An idempotency key of 1 to 200 characters is required.");
  }
  const digest = contentDigest({ kind: "assignment-feedback", assignmentId, guidance: input.guidance.trim(), source: input.source,
    entryId: input.entryId ?? null, expectedRevision: input.expectedRevision ?? null });
  return module.database.begin(async tx => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([projectId, actor.id, idempotencyKey])]);
    const project = await requireProject(tx, actor, projectId, "feedback");
    if (project.state === "Archived") throw new ProductError(409, "project_archived", "Archived projects cannot receive new feedback.");
    const [binding] = await tx.unsafe<{ id: string }>(`select a.id from bp_assignments a
      join bp_conversations c on c.project_id = a.project_id
      join channel_memberships cm on cm.channel_id = c.native_channel_id and cm.user_id = $4
      join channels ch on ch.id = c.native_channel_id and ch.deleted_at is null
      where a.project_id = $1 and a.id = $2 and c.native_channel_id = $3
      for share of a, c, cm, ch`, [projectId, assignmentId, input.source.conversationId, actor.id]);
    if (!binding) throw new ProductError(404, "feedback_source_not_found", "Assignment or feedback source not found.");
    const [groupMessage] = await tx.unsafe<{ id: string }>(`select id from group_messages where channel_id=$1 and id=$2
      and owner_user_id=$3 and agent_id is null and status='completed' for share`, [input.source.conversationId, input.source.messageId, actor.id]);
    if (!groupMessage) {
      const [mapping] = await tx.unsafe<{ threadId: string }>(`select thread_id as "threadId" from intelligence_channel_mappings
        where channel_id=$1 and user_id=$2 for share`, [input.source.conversationId, actor.id]);
      let verified = false;
      try { verified = !!mapping && !!transcript && await transcript(mapping.threadId, actor.id, input.source.messageId); } catch { /* unavailable fails closed */ }
      if (!verified) throw new ProductError(404, "feedback_source_not_found", "Assignment or feedback source not found.");
    }
    const [previous] = await tx.unsafe<{ digest: string; response: { id: string; revision: number } }>(
      "select digest,response from bp_mutations where project_id=$1 and actor_id=$2 and mutation_key=$3", [projectId, actor.id, idempotencyKey]);
    if (previous) {
      if (previous.digest !== digest) throw new ProductError(409, "idempotency_conflict", "The idempotency key was already used with another payload.");
      return previous.response;
    }
    const id = input.entryId ?? randomUUID();
    let revision = 1;
    if (input.entryId) {
      const [current] = await tx.unsafe<{ revision: number }>(`select e.current_revision as revision from bp_memory_entries e
        join bp_memory_revisions r on (r.project_id,r.assignment_id,r.entry_id,r.revision) = (e.project_id,e.assignment_id,e.id,e.current_revision)
        join bp_conversations c on c.project_id=e.project_id and c.native_channel_id=r.feedback_source->>'conversationId'
        join channel_memberships cm on cm.channel_id=c.native_channel_id and cm.user_id=$4
        join channels ch on ch.id=c.native_channel_id and ch.deleted_at is null
        where e.project_id=$1 and e.assignment_id=$2 and e.id=$3 for update of e`, [projectId, assignmentId, id, actor.id]);
      if (!current) throw new ProductError(404, "memory_not_found", "Guidance not found.");
      if (current.revision !== input.expectedRevision) throw new ProductError(409, "guidance_conflict", "The guidance changed; review the current version before correcting it.");
      revision = current.revision + 1;
      await tx.unsafe("update bp_memory_entries set current_revision=$4 where project_id=$1 and assignment_id=$2 and id=$3", [projectId, assignmentId, id, revision]);
    } else {
      await tx.unsafe("insert into bp_memory_entries(project_id,assignment_id,id,current_revision) values ($1,$2,$3,1)", [projectId, assignmentId, id]);
    }
    await tx.unsafe(`insert into bp_memory_revisions(project_id,assignment_id,entry_id,revision,guidance,feedback_source,author_id)
      values ($1,$2,$3,$4,$5,$6::text::jsonb,$7)`, [projectId, assignmentId, id, revision, input.guidance.trim(), JSON.stringify(input.source), actor.id]);
    const response = { id, revision };
    await tx.unsafe("insert into bp_mutations(project_id,actor_id,mutation_key,digest,response) values ($1,$2,$3,$4,$5::text::jsonb)",
      [projectId, actor.id, idempotencyKey, digest, JSON.stringify(response)]);
    return response;
  });
}

export async function currentGuidance(module: ProductModule, actor: ProductActor, projectId: string, assignmentId: string): Promise<Memory[]> {
  return module.database.begin(async tx => {
    await requireProject(tx, actor, projectId, "read");
    return tx.unsafe<Memory>(`select r.entry_id as id,r.revision,r.guidance,r.feedback_source as source,
      r.author_id as "authorId",r.created_at as "createdAt" from bp_memory_entries e
      join bp_memory_revisions r on (r.project_id,r.assignment_id,r.entry_id,r.revision) = (e.project_id,e.assignment_id,e.id,e.current_revision)
      join bp_conversations c on c.project_id=e.project_id and c.native_channel_id=r.feedback_source->>'conversationId'
      join channel_memberships cm on cm.channel_id=c.native_channel_id and cm.user_id=$3
      join channels ch on ch.id=c.native_channel_id and ch.deleted_at is null
      where e.project_id=$1 and e.assignment_id=$2 order by r.created_at,r.entry_id`, [projectId, assignmentId, actor.id]);
  });
}
