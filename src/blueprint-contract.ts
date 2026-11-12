import { extname } from 'node:path';
import { validateSchema, type Schema } from './schema.js';
import { validateBusiness } from './business.js';
import type { Blueprint } from './types.js';

/** Shared publication checks. File access stays at the package boundary. */
export function validateContract(blueprint: unknown, schema: Schema): string[] {
  const errors = validateSchema(blueprint, schema);
  if (errors.length) return errors;
  const b = blueprint as Blueprint;
  const fail = (message: string) => errors.push(message);
  const groups = ['agents', 'connections', 'tools', 'resources', 'environments', 'workflow', 'qualityGates'] as const;
  const ids = {} as Record<typeof groups[number], Set<string>>;
  for (const group of groups) {
    ids[group] = new Set();
    for (const item of b[group]) {
      if (ids[group].has(item.id)) fail(`${group}: duplicate id ${item.id}`);
      ids[group].add(item.id);
    }
  }
  const ref = (group: typeof groups[number], id: string, context: string) => { if (!ids[group].has(id)) fail(`${context}: unknown ${group} reference ${id}`); };
  ref('agents', b.entrypoint, 'entrypoint');
  const agents = new Map(b.agents.map(agent => [agent.id, agent]));
  if (agents.get(b.entrypoint)?.tier !== 'core') fail('entrypoint must be a core agent');
  if (b.intake?.handoffTo) {
    const target = b.intake.handoffTo;
    if (target === b.entrypoint || agents.get(target)?.tier !== 'core' ||
        !b.connections.some(connection => connection.from === b.entrypoint && connection.to === target)) {
      fail('intake.handoffTo must be a connected core agent distinct from the entrypoint');
    }
  }
  if (b.intake?.discoveryBy) {
    const { discoveryBy, handoffTo } = b.intake;
    if (discoveryBy === b.entrypoint || discoveryBy === handoffTo || agents.get(discoveryBy)?.tier !== 'core' ||
        !b.connections.some(connection => connection.from === handoffTo && connection.to === discoveryBy)) {
      fail('intake.discoveryBy must be a distinct core agent connected from intake.handoffTo');
    }
  }
  if (!b.agents.some(a => a.tier === 'core' && a.id !== b.entrypoint)) fail('define at least one core specialist');
  for (const agent of b.agents) {
    const fields = agent.readiness ?? [];
    if (new Set(fields.map(field => field.id)).size !== fields.length) fail(`${agent.id}: duplicate readiness field ID`);
    ref('environments', agent.environment, agent.id);
    for (const id of agent.tools) ref('tools', id, agent.id);
    for (const id of agent.resources) ref('resources', id, agent.id);
    if (agent.tier === 'optional' && !agent.activateWhen) fail(`${agent.id}: optional agent needs activateWhen`);
    if (agent.runtime?.kind === 'local') {
      const runtime = agent.runtime;
      const extensions = runtime.language === 'typescript' ? ['.ts', '.mts', '.cts'] : ['.py'];
      if (!extensions.includes(extname(runtime.entrypoint))) fail(`${agent.id}: ${runtime.language} entrypoint has an incompatible file extension`);
    }
  }
  for (const tool of b.tools) if (tool.transport === 'mcp' && !tool.endpointEnv) fail(`${tool.id}: MCP tool needs endpointEnv`);
  for (const connection of b.connections) {
    ref('agents', connection.from, connection.id);
    ref('agents', connection.to, connection.id);
    if (connection.from === connection.to) fail(`${connection.id}: self connection`);
  }
  // Every specialist must be reachable from the lead through directed handoffs.
  const reached = new Set([b.entrypoint]);
  let previous;
  do {
    previous = reached.size;
    b.connections.forEach(edge => { if (reached.has(edge.from)) reached.add(edge.to); });
  } while (reached.size !== previous);
  b.agents.forEach(agent => { if (!reached.has(agent.id)) fail(`${agent.id}: unreachable from entrypoint`); });
  const gateMap = new Map(b.qualityGates.map(gate => [gate.id, gate]));
  for (const step of b.workflow) {
    ref('agents', step.owner, step.id);
    if (agents.get(step.owner)?.tier !== 'core') fail(`${step.id}: workflow owner must be core`);
    for (const id of step.dependsOn) ref('workflow', id, step.id);
    for (const id of step.gates) ref('qualityGates', id, step.id);
    if (!step.gates.length) fail(`${step.id}: requires a quality gate`);
    if (!step.gates.some(id => gateMap.get(id)?.owner === step.owner)) fail(`${step.id}: owner must own at least one of its gates`);
  }
  for (const gate of b.qualityGates) {
    ref('agents', gate.owner, gate.id);
    if (agents.get(gate.owner)?.tier !== 'core') fail(`${gate.id}: quality gate owner must be core`);
    if (!b.workflow.some(step => step.gates.includes(gate.id))) fail(`${gate.id}: unused quality gate`);
  }
  const steps = new Map(b.workflow.map(step => [step.id, step]));
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) { fail(`workflow: dependency cycle at ${id}`); return; }
    if (visited.has(id) || !steps.has(id)) return;
    visiting.add(id);
    steps.get(id)!.dependsOn.forEach(visit);
    visiting.delete(id); visited.add(id);
  }
  b.workflow.forEach(step => visit(step.id));
  errors.push(...validateBusiness(b));
  return errors;
}
