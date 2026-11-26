import { ProductError } from './access.js';
import type { ProductModule } from './module.js';
import { resolvePhaseActivity, type PhaseRequest } from './phase-activity.js';

export type PhaseMcpGrant = {
  toolId: string;
  nativeRef: string;
  resourceBindings: { argumentPath: string; artifactType: string; payloadPath: string }[];
};

export type GrantedPhaseMcpTool = { ref: string; execute(args: unknown): Promise<unknown> };

/** Expose only declared native refs and refuse calls before they reach OpenBot's connector when scope fails. */
export function bindPhaseMcpTools<T extends GrantedPhaseMcpTool>(tools: T[], grants: PhaseMcpGrant[],
  authorize: (grant: PhaseMcpGrant, args: unknown) => Promise<unknown>) {
  const byRef = new Map(grants.map(grant => [grant.nativeRef, grant]));
  return tools.filter(tool => byRef.has(tool.ref)).map(tool => ({
    ...tool,
    execute: async (args: unknown) => {
      const grant = byRef.get(tool.ref);
      if (!grant) return 'Refused. This MCP tool is not authorized for the active project phase.';
      try { await authorize(grant, args); }
      catch { return 'Refused. This MCP tool is not authorized for the active project phase.'; }
      return tool.execute(args);
    },
  }));
}

function pointerValue(value: unknown, pointer: string): unknown {
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return undefined;
  let current = value;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!current || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Require the native tool grant and all resource arguments to remain bound to this active phase. */
export async function authorizePhaseMcpCall(module: ProductModule, request: PhaseRequest, botId: string,
  grant: PhaseMcpGrant, args: unknown) {
  const denied = () => new ProductError(403, 'project_mcp_scope_denied', 'This MCP tool is not authorized for the active project phase.');
  if (!args || typeof args !== 'object' || Array.isArray(args) || !grant || !Array.isArray(grant.resourceBindings) || !grant.resourceBindings.length) throw denied();
  await module.database.begin(async tx => {
    const phase = await resolvePhaseActivity(tx, request);
    const agent = phase.definition.agents.find(item => item.id === botId);
    const tool = phase.definition.tools.find(item => item.id === grant.toolId);
    if (phase.botId !== botId || !agent?.tools.includes(grant.toolId) || !tool || tool.transport !== 'mcp' ||
        tool.access !== 'read' || !tool.nativeRefs?.includes(grant.nativeRef) ||
        !tool.resourceBindings || tool.resourceBindings.length !== grant.resourceBindings.length) throw denied();
    for (const binding of grant.resourceBindings) {
      if (!tool.resourceBindings.some(configured => configured.argumentPath === binding.argumentPath &&
          configured.artifactType === binding.artifactType && configured.payloadPath === binding.payloadPath)) throw denied();
      if (!phase.action.inputTypes.includes(binding.artifactType) || !phase.inputRevisions.some(item => item.type === binding.artifactType)) throw denied();
      const input = phase.inputRevisions.find(item => item.type === binding.artifactType)!;
      const [artifact] = await tx.unsafe<{ payload: unknown }>(`select r.payload from bp_artifacts a
        join bp_artifact_revisions r on r.project_id=a.project_id and r.artifact_id=a.id
        where a.project_id=$1 and a.type_key=$2 and r.id=$3 and a.status='supplied'
          and (a.allowed_user_ids is null or $4=any(a.allowed_user_ids)) for share of a,r`,
      [request.projectId, binding.artifactType, input.revisionId, phase.actorId]);
      const expected = artifact && pointerValue(artifact.payload, binding.payloadPath);
      const actual = pointerValue(args, binding.argumentPath);
      if (typeof expected !== 'string' || actual !== expected) throw denied();
    }
  });
  return true;
}

export const phaseMcpPointerValue = pointerValue;
