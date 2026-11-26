import { createHash } from 'node:crypto';
import { ProductError, type ProductActor, type ProductQuery } from './access.js';
import { recordGuidance, type FeedbackTranscript } from './feedback.js';
import type { ProductModule } from './module.js';
import { requireNativeBotContext, type VerifiedNativeRun } from './native-context.js';

type Callback = { name: string; args: Record<string, unknown>; actorId: string; botId: string; run: VerifiedNativeRun };
const refusal = 'Refused. Project feedback cannot be recorded for this bot turn.';

/** Called only after OpenBot authenticates the native bot turn and actor. */
export async function callNativeFeedbackTool(module: ProductModule, actor: ProductActor, input: Callback, transcript?: FeedbackTranscript) {
  if (input.name !== 'project_memory_propose') return null;
  const run = input.run, args = input.args;
  if (!run || input.actorId !== actor.id || run.actorId !== actor.id || input.botId !== run.botId ||
      typeof run.runId !== 'string' || !run.runId || run.runId.length > 200 ||
      !args || typeof args !== 'object' || Array.isArray(args) ||
      Object.keys(args).some(key => !['messageId','guidance','entryId','expectedRevision','conflict','resolveConflictId'].includes(key)) ||
      typeof args.messageId !== 'string' || !args.messageId || args.messageId.length > 200 || typeof args.guidance !== 'string') {
    return { text: refusal, isError: true };
  }
  try {
    async function resolve(tx: ProductQuery) {
      const context = await requireNativeBotContext(tx, actor, run, 'feedback');
      const [allowed] = await tx.unsafe<{ id: string }>(`select a.id from bp_assignments a
        join bp_projects p on p.id=a.project_id join bp_blueprint_versions b on b.blueprint_key=p.blueprint_key and b.version=p.blueprint_version
        where a.project_id=$1 and a.id=$2 and a.native_bot_id=$3 and exists (
          select 1 from jsonb_array_elements(b.definition#>'{business,roles}') role
          where role->>'id'=a.role_key and role->>'agentId'=a.native_bot_id)
        for share of a,p,b`, [context.project.id, context.assignmentId, input.botId]);
      if (!allowed) throw new ProductError(403, 'project_permission_denied', refusal);
      return context;
    }
    const context = await module.database.begin(resolve);
    const key = 'bot-feedback:' + createHash('sha256').update(JSON.stringify([actor.id, input.botId, run.runId, args.messageId, args.entryId ?? null])).digest('hex');
    const result = await recordGuidance(module, actor, context.project.id, context.assignmentId, {
      guidance: args.guidance, source: { conversationId: context.channelId, messageId: args.messageId },
      ...(args.entryId !== undefined ? { entryId: args.entryId as string } : {}),
      ...(args.expectedRevision !== undefined ? { expectedRevision: args.expectedRevision as number } : {}),
      ...(args.conflict !== undefined ? { conflict: args.conflict as boolean } : {}),
      ...(args.resolveConflictId !== undefined ? { resolveConflictId: args.resolveConflictId as string } : {}),
    }, key, transcript, async tx => {
      const current = await resolve(tx);
      if (current.project.id !== context.project.id || current.assignmentId !== context.assignmentId || current.channelId !== context.channelId) {
        throw new ProductError(409, 'project_binding_changed', refusal);
      }
    });
    return { text: JSON.stringify(result), isError: false };
  } catch (error) {
    if (error instanceof ProductError) return { text: error.status === 409 || error.status === 422 ? error.message : refusal, isError: true };
    throw error;
  }
}
