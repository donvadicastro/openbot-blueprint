import { randomUUID } from "node:crypto";
import { ProductError, requireProject, type ProductActor, type ProductQuery } from "./access.js";
import type { ProductModule } from "./module.js";
import { contentDigest } from "./store.js";
import { boundGuidance } from "./feedback-context.js";

type Source = { conversationId: string; messageId: string };
type Memory = { id: string; revision: number; guidance: string; source?: Source; authorId?: string; createdAt?: string };
type GuidanceInput = {
  guidance: string; source: Source; entryId?: string; expectedRevision?: number;
  conflict?: boolean; resolveConflictId?: string;
};
export type FeedbackTranscript = (threadId: string, userId: string, messageId: string) => Promise<boolean>;

const pendingConflict = new ProductError(409, "guidance_conflict_pending",
  "This feedback needs a clarification from a new message before it can change.");

/** Read the current, project-scoped guidance for one assignment inside an authorized transaction. */
export async function readGuidance(tx: ProductQuery, actor: ProductActor, projectId: string, assignmentId: string): Promise<Memory[]> {
  return tx.unsafe<Memory>(`select r.entry_id as id,r.revision,r.guidance,r.feedback_source as source,
    r.author_id as "authorId",r.created_at as "createdAt" from bp_memory_entries e
    join bp_memory_revisions r on (r.project_id,r.assignment_id,r.entry_id,r.revision) = (e.project_id,e.assignment_id,e.id,e.current_revision)
    join bp_conversations c on c.project_id=e.project_id and c.native_channel_id=r.feedback_source->>'conversationId'
    join channel_memberships cm on cm.channel_id=c.native_channel_id and cm.user_id=$3
    join channels ch on ch.id=c.native_channel_id and ch.deleted_at is null
    where e.project_id=$1 and e.assignment_id=$2
      and not exists (select 1 from bp_memory_conflicts x where x.project_id=e.project_id
        and x.assignment_id=e.assignment_id and x.entry_id=e.id and x.state='Pending')
    order by r.created_at,r.entry_id`, [projectId, assignmentId, actor.id]);
}

/** Read the ambiguous feedback an assignment is waiting on. */
export async function readGuidanceConflicts(tx: ProductQuery, actor: ProductActor, projectId: string, assignmentId: string) {
  return tx.unsafe<{ id: string; entryId: string; baseRevision: number; current: string; proposed: string; createdAt: string }>(`
    select x.id,x.entry_id as "entryId",x.base_revision as "baseRevision",r.guidance as current,
      x.proposed_guidance as proposed,x.created_at as "createdAt"
    from bp_memory_conflicts x
    join bp_memory_revisions r on (r.project_id,r.assignment_id,r.entry_id,r.revision)
      = (x.project_id,x.assignment_id,x.entry_id,x.base_revision)
    join bp_conversations c on c.project_id=x.project_id and c.native_channel_id=x.feedback_source->>'conversationId'
    join channel_memberships cm on cm.channel_id=c.native_channel_id and cm.user_id=$3
    join channels ch on ch.id=c.native_channel_id and ch.deleted_at is null
    where x.project_id=$1 and x.assignment_id=$2 and x.state='Pending'
    order by x.created_at,x.id for share of x`, [projectId, assignmentId, actor.id]);
}

/** Corrections must identify the exact version they replace; ambiguous conflicts stay unresolved
 * until a later message clarifies them. */
export async function recordGuidance(module: ProductModule, actor: ProductActor, projectId: string, assignmentId: string,
  input: GuidanceInput, idempotencyKey: string, transcript?: FeedbackTranscript,
  recheck?: (tx: ProductQuery) => Promise<void>) {
  if (typeof input.guidance !== "string" || !input.guidance.trim() || input.guidance.length > 4000 ||
      !input.source || typeof input.source.conversationId !== "string" || typeof input.source.messageId !== "string" ||
      !input.source.conversationId || input.source.conversationId.length > 200 || !input.source.messageId || input.source.messageId.length > 200 ||
      Object.keys(input.source).some(key => key !== "conversationId" && key !== "messageId") ||
      (input.entryId !== undefined && (typeof input.entryId !== "string" || !input.entryId || input.entryId.length > 200 || !Number.isInteger(input.expectedRevision) || input.expectedRevision! < 1)) ||
      (input.entryId === undefined && input.expectedRevision !== undefined) ||
      (input.conflict !== undefined && typeof input.conflict !== "boolean") ||
      (input.conflict === true && input.resolveConflictId !== undefined) ||
      (input.resolveConflictId !== undefined && (typeof input.resolveConflictId !== "string" || !input.resolveConflictId || input.resolveConflictId.length > 200))) {
    throw new ProductError(422, "invalid_feedback", "Provide guidance and its conversation and message, and identify the current revision for a correction.");
  }
  if (typeof idempotencyKey !== "string" || !idempotencyKey.length || idempotencyKey.length > 200) {
    throw new ProductError(422, "invalid_idempotency_key", "An idempotency key of 1 to 200 characters is required.");
  }
  const digest = contentDigest({ kind: "assignment-feedback", assignmentId, guidance: input.guidance.trim(), source: input.source,
    entryId: input.entryId ?? null, expectedRevision: input.expectedRevision ?? null,
    conflict: input.conflict ?? false, resolveConflictId: input.resolveConflictId ?? null });
  return module.database.begin(async tx => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([projectId, actor.id, idempotencyKey])]);
    const project = await requireProject(tx, actor, projectId, "feedback");
    if (project.state === "Archived") throw new ProductError(409, "project_archived", "Archived projects cannot receive new feedback.");
    if (recheck) await recheck(tx);
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
    const [previous] = await tx.unsafe<{ digest: string; response: Record<string, unknown> }>(
      "select digest,response from bp_mutations where project_id=$1 and actor_id=$2 and mutation_key=$3", [projectId, actor.id, idempotencyKey]);
    if (previous) {
      if (previous.digest !== digest) throw new ProductError(409, "idempotency_conflict", "The idempotency key was already used with another payload.");
      return previous.response;
    }
    if (input.entryId === undefined) {
      if (input.conflict || input.resolveConflictId !== undefined) {
        throw new ProductError(422, "invalid_feedback", "A conflict or clarification must identify the guidance entry it concerns.");
      }
      const id = randomUUID();
      await tx.unsafe("insert into bp_memory_entries(project_id,assignment_id,id,current_revision) values ($1,$2,$3,1)", [projectId, assignmentId, id]);
      await tx.unsafe(`insert into bp_memory_revisions(project_id,assignment_id,entry_id,revision,guidance,feedback_source,author_id)
        values ($1,$2,$3,$4,$5,$6::text::jsonb,$7)`, [projectId, assignmentId, id, 1, input.guidance.trim(), JSON.stringify(input.source), actor.id]);
      const response = { id, revision: 1 };
      await tx.unsafe("insert into bp_mutations(project_id,actor_id,mutation_key,digest,response) values ($1,$2,$3,$4,$5::text::jsonb)",
        [projectId, actor.id, idempotencyKey, digest, JSON.stringify(response)]);
      return response;
    }
    const id = input.entryId;
    const [current] = await tx.unsafe<{ revision: number }>(`select e.current_revision as revision from bp_memory_entries e
      join bp_memory_revisions r on (r.project_id,r.assignment_id,r.entry_id,r.revision) = (e.project_id,e.assignment_id,e.id,e.current_revision)
      join bp_conversations c on c.project_id=e.project_id and c.native_channel_id=r.feedback_source->>'conversationId'
      join channel_memberships cm on cm.channel_id=c.native_channel_id and cm.user_id=$4
      join channels ch on ch.id=c.native_channel_id and ch.deleted_at is null
      where e.project_id=$1 and e.assignment_id=$2 and e.id=$3 for update of e`, [projectId, assignmentId, id, actor.id]);
    if (!current) throw new ProductError(404, "memory_not_found", "Guidance not found.");
    const [pending] = await tx.unsafe<{ id: string; baseRevision: number; messageId: string; conversationId: string }>(`select id,base_revision as "baseRevision",
      feedback_source->>'messageId' as "messageId",feedback_source->>'conversationId' as "conversationId"
      from bp_memory_conflicts where project_id=$1 and assignment_id=$2 and entry_id=$3 and state='Pending' for update`, [projectId, assignmentId, id]);
    if (input.resolveConflictId !== undefined) {
      if (!pending || pending.id !== input.resolveConflictId) {
        throw new ProductError(409, "guidance_conflict_pending", "The feedback conflict to resolve is unavailable.");
      }
      if (pending.messageId === input.source.messageId && pending.conversationId === input.source.conversationId) {
        throw new ProductError(409, "guidance_conflict_pending", "Clarify the feedback in a new message.");
      }
      if (pending.baseRevision !== input.expectedRevision) {
        throw new ProductError(409, "guidance_conflict", "The guidance changed; review the current version before correcting it.");
      }
      const revision = current.revision + 1;
      await tx.unsafe("update bp_memory_entries set current_revision=$4 where project_id=$1 and assignment_id=$2 and id=$3", [projectId, assignmentId, id, revision]);
      await tx.unsafe(`insert into bp_memory_revisions(project_id,assignment_id,entry_id,revision,guidance,feedback_source,author_id)
        values ($1,$2,$3,$4,$5,$6::text::jsonb,$7)`, [projectId, assignmentId, id, revision, input.guidance.trim(), JSON.stringify(input.source), actor.id]);
      await tx.unsafe(`update bp_memory_conflicts set state='Resolved',resolution_revision=$4,resolved_at=now()
        where project_id=$1 and assignment_id=$2 and id=$3`, [projectId, assignmentId, pending.id, revision]);
      // Wake any run that is waiting for this specialist's clarified feedback.
      await tx.unsafe(`insert into bp_reconciliation_intents(project_id,run_id,occurrence_id,assignment_id,conflict_id)
        select o.project_id,o.run_id,o.id,o.assignment_id,$3::text from bp_phase_occurrences o
        join bp_workflow_runs r on (r.project_id,r.id)=(o.project_id,o.run_id)
        join bp_action_attempts a on (a.project_id,a.run_id,a.occurrence_id)=(o.project_id,o.run_id,o.id)
        where o.project_id=$1 and o.assignment_id=$2 and r.state='Running' and r.current_phase=o.phase_key
          and a.state in ('Pending','Running')
        on conflict do nothing`, [projectId, assignmentId, pending.id]);
      const response = { id, revision };
      await tx.unsafe("insert into bp_mutations(project_id,actor_id,mutation_key,digest,response) values ($1,$2,$3,$4,$5::text::jsonb)",
        [projectId, actor.id, idempotencyKey, digest, JSON.stringify(response)]);
      return response;
    }
    if (pending) throw pendingConflict;
    if (current.revision !== input.expectedRevision) {
      throw new ProductError(409, "guidance_conflict", "The guidance changed; review the current version before correcting it.");
    }
    if (input.conflict) {
      const conflictId = randomUUID();
      await tx.unsafe(`insert into bp_memory_conflicts(project_id,assignment_id,id,entry_id,base_revision,proposed_guidance,feedback_source,author_id)
        values ($1,$2,$3,$4,$5,$6,$7::text::jsonb,$8)`, [projectId, assignmentId, conflictId, id, current.revision,
        input.guidance.trim(), JSON.stringify(input.source), actor.id]);
      const response = { id, revision: current.revision, status: "needs-clarification", conflictId };
      await tx.unsafe("insert into bp_mutations(project_id,actor_id,mutation_key,digest,response) values ($1,$2,$3,$4,$5::text::jsonb)",
        [projectId, actor.id, idempotencyKey, digest, JSON.stringify(response)]);
      return response;
    }
    const revision = current.revision + 1;
    await tx.unsafe("update bp_memory_entries set current_revision=$4 where project_id=$1 and assignment_id=$2 and id=$3", [projectId, assignmentId, id, revision]);
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
    return readGuidance(tx, actor, projectId, assignmentId);
  });
}

/** Resolve guidance for the bot bound to this conversation. Missing conversation access or an
 * ambiguous shared bot without a trusted assignment returns no guidance or fails closed. */
export async function botGuidance(module: ProductModule, actor: ProductActor, channelId: string, nativeBotId: string,
  assignmentId?: string): Promise<Memory[]> {
  return module.database.begin(async tx => {
    const [conversation] = await tx.unsafe<{ projectId: string }>(`select c.project_id as "projectId" from bp_conversations c
      join channel_memberships cm on cm.channel_id=c.native_channel_id and cm.user_id=$2
      join channels ch on ch.id=c.native_channel_id and ch.deleted_at is null
      where c.native_channel_id=$1 for share of c,cm,ch`, [channelId, actor.id]);
    if (!conversation) return [];
    await requireProject(tx, actor, conversation.projectId, "read");
    const assignments = await tx.unsafe<{ id: string }>(`select a.id from bp_assignments a
      where a.project_id=$1 and a.native_bot_id=$2 and ($3::text is null or a.id=$3)
      order by a.id for share of a`, [conversation.projectId, nativeBotId, assignmentId ?? null]);
    if (!assignments.length) {
      // A bot that is assigned elsewhere must not learn which project this channel belongs to.
      const [known] = assignmentId === undefined
        ? await tx.unsafe("select 1 from bp_assignments where native_bot_id=$1 limit 1", [nativeBotId]) : [];
      if (known) return [];
      throw new ProductError(404, "project_not_found", "Project not found.");
    }
    if (assignments.length !== 1) throw new ProductError(404, "project_not_found", "Project not found.");
    return readGuidance(tx, actor, conversation.projectId, assignments[0].id);
  });
}
