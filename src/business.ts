import type { Blueprint, BusinessContract, BusinessWorkflow } from './types.js';

/** Validate references after shape validation has succeeded. */
export function validateBusiness(blueprint: Blueprint): string[] {
  const business = blueprint.business;
  if (!business) return [];
  const errors: string[] = [];
  const fail = (message: string) => errors.push(`business: ${message}`);
  const roles = indexed(business.roles, 'role', errors);
  const artifacts = indexed(business.artifactTypes, 'artifact type', errors);
  const actions = indexed(business.actions, 'action', errors);
  const views = indexed(business.views, 'view', errors);
  indexed(business.workflows, 'workflow', errors);
  const agents = new Set(blueprint.agents.map(agent => agent.id));
  const reference = (found: boolean, description: string) => {
    if (!found) fail(description);
  };
  reference(roles.has(business.teamLeadRole), 'unknown Team Lead role');
  if (roles.has(business.teamLeadRole)) {
    reference(roles.get(business.teamLeadRole)?.agentId === blueprint.entrypoint, 'Team Lead agent must match the blueprint entrypoint');
  }
  for (const role of business.roles) {
    reference(agents.has(role.agentId), `${role.id} references an unknown agent`);
    reference(views.get(role.viewId)?.role === role.id, `${role.id} references an unknown or differently owned view`);
    for (const id of role.actions) {
      reference(actions.get(id)?.role === role.id, `${role.id} action ${id} has a different or missing owner`);
    }
    for (const check of role.startupChecks.filter(check => check.kind === "artifact-access")) {
      reference(artifacts.has(check.artifactType ?? ""), `${role.id} startup check references an unknown artifact`);
      const artifact = artifacts.get(check.artifactType ?? "");
      if (artifact) reference(artifact.owner === role.id || artifact.consumers.includes(role.id) || artifact.producers.includes(role.id), `${role.id} startup check lacks access to ${artifact.id}`);
    }
  }
  for (const artifact of business.artifactTypes) {
    errors.push(...validateDataSchema(artifact.schema, `business: ${artifact.id} schema`));
    for (const id of [artifact.owner, ...artifact.producers, ...artifact.consumers]) {
      reference(roles.has(id), `${artifact.id} references unknown role ${id}`);
    }
    for (const relationship of artifact.relationships) {
      reference(artifacts.has(relationship.targetType), `${artifact.id} references an unknown relationship type`);
    }
  }
  for (const id of [...business.initialization.requiredArtifacts, ...business.initialization.recommendedArtifacts]) {
    reference(artifacts.has(id), `initialization references unknown artifact ${id}`);
  }
  for (const action of business.actions) {
    reference(roles.get(action.role)?.actions.includes(action.id) === true, `${action.id} is not assigned to its role`);
    for (const id of [...action.inputTypes, ...action.outputTypes]) {
      reference(artifacts.has(id), `${action.id} references unknown artifact type ${id}`);
    }
    for (const id of action.inputTypes) {
      if (artifacts.has(id)) reference(artifacts.get(id)?.consumers.includes(action.role) === true, `${action.id} role cannot consume ${id}`);
    }
    for (const id of action.outputTypes) {
      if (artifacts.has(id)) reference(artifacts.get(id)?.producers.includes(action.role) === true, `${action.id} role cannot produce ${id}`);
    }
    const statuses = new Set<string>();
    for (const result of action.results) {
      if (statuses.has(result.status)) fail(`${action.id} has duplicate result status ${result.status}`);
      statuses.add(result.status);
      for (const id of result.requiredOutputTypes) {
        reference(action.outputTypes.includes(id), `${action.id} result requires an undeclared output ${id}`);
      }
    }
  }
  for (const view of business.views) {
    reference(roles.has(view.role), `${view.id} references an unknown role`);
    reference(roles.get(view.role)?.viewId === view.id, `${view.id} is not the role's declared view`);
    for (const id of view.recordTypes) reference(artifacts.has(id), `${view.id} references an unknown record type`);
  }
  for (const workflow of business.workflows) errors.push(...validateWorkflow(workflow, business));
  return errors;
}

function indexed<T extends { id: string }>(items: T[], name: string, errors: string[]): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    if (result.has(item.id)) errors.push(`business: duplicate ${name} ${item.id}`);
    result.set(item.id, item);
  }
  return result;
}

/** Temporary plans use exactly the same validation as published plans. */
export function validateWorkflow(workflow: BusinessWorkflow, business: BusinessContract): string[] {
  const errors: string[] = [];
  const fail = (message: string) => errors.push(`workflow ${workflow.id}: ${message}`);
  const phases = indexed(workflow.phases, 'phase', errors);
  const actions = new Map(business.actions.map(action => [action.id, action]));
  const artifacts = new Map(business.artifactTypes.map(artifact => [artifact.id, artifact]));
  if (!phases.has(workflow.startPhase)) fail('unknown start phase');
  for (const terminal of workflow.terminalPhases) {
    if (!phases.has(terminal)) fail(`unknown terminal phase ${terminal}`);
  }
  for (const phase of workflow.phases) {
    const terminal = workflow.terminalPhases.includes(phase.id);
    if (terminal !== Boolean(phase.terminal)) fail(`${phase.id} has an inconsistent terminal declaration`);
    if (!terminal && !actions.has(phase.action ?? '')) fail(`${phase.id} requires a known action`);
    if (terminal && phase.action) fail(`${phase.id} cannot execute an action after completion`);
  }
  for (const transition of workflow.transitions) {
    if (!phases.has(transition.from) || !phases.has(transition.to)) fail('transition references an unknown phase');
    if (workflow.terminalPhases.includes(transition.from)) fail('terminal phase has an outgoing transition');
    const source = phases.get(transition.from);
    const action = actions.get(source?.action ?? '');
    const condition = transition.when;
    if (condition.recordType !== undefined || condition.field !== undefined || condition.equals !== undefined) {
      const artifact = artifacts.get(condition.recordType ?? '');
      if (!artifact || !action?.outputTypes.includes(artifact.id)) fail('condition must reference a declared output record type');
      if (!condition.field || condition.equals === undefined) fail('record condition requires a field and comparison value');
      if (artifact && condition.field && !declaresField(artifact.schema, condition.field)) fail('condition references an undeclared record field');
    }
    if (action && !action.results.some(result => result.status === transition.when.status)) {
      fail(`${transition.from} transition uses an undeclared result status`);
    }
  }
  for (let i = 0; i < workflow.transitions.length; i++) {
    const left = workflow.transitions[i];
    for (const right of workflow.transitions.slice(i + 1)) {
      if (left.from === right.from && conditionsOverlap(left.when, right.when)) {
        fail(`${left.from} has overlapping transition conditions`);
      }
    }
  }
  const reached = new Set<string>();
  function visit(id: string) {
    if (reached.has(id)) return;
    reached.add(id);
    for (const transition of workflow.transitions) {
      if (transition.from === id) visit(transition.to);
    }
  }
  visit(workflow.startPhase);
  for (const id of phases.keys()) if (!reached.has(id)) fail(`${id} is unreachable`);
  if (!workflow.terminalPhases.some(id => reached.has(id))) fail('no terminal outcome is reachable');
  const terminating = new Set(workflow.terminalPhases);
  let previous = -1;
  while (previous !== terminating.size) {
    previous = terminating.size;
    for (const transition of workflow.transitions) {
      if (terminating.has(transition.to)) terminating.add(transition.from);
    }
  }
  for (const id of phases.keys()) if (!terminating.has(id)) fail(`${id} cannot reach a terminal outcome`);
  return errors;
}

function conditionsOverlap(
  left: BusinessWorkflow['transitions'][number]['when'],
  right: BusinessWorkflow['transitions'][number]['when'],
): boolean {
  if (left.status !== right.status) return false;
  if (left.decision && right.decision && left.decision !== right.decision) return false;
  if (left.recordType === right.recordType && left.field && left.field === right.field
    && left.equals !== undefined && right.equals !== undefined
    && JSON.stringify(left.equals) !== JSON.stringify(right.equals)) return false;
  return true;
}


function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function declaresField(schema: Record<string, unknown>, field: string): boolean {
  let current = schema;
  const seen = new Set<unknown>();
  while (typeof current.$ref === 'string' && !seen.has(current)) {
    seen.add(current);
    const name = current.$ref.replace(/^#\/\$defs\//, '');
    const definition = isObject(schema.$defs) ? schema.$defs[name] : undefined;
    if (!isObject(definition)) return false;
    current = definition;
  }
  return isObject(current.properties) && Object.hasOwn(current.properties, field);
}

/** Reject assertions that the dependency-free runtime cannot enforce. */
function validateDataSchema(root: Record<string, unknown>, label: string): string[] {
  const errors: string[] = [];
  const nodes: Record<string, unknown>[] = [];
  const definitions = isObject(root.$defs) ? root.$defs : {};
  const supported = new Set([
    '$ref', '$defs', '$schema', '$id', '$comment', 'title', 'description', 'default', 'examples',
    'type', 'enum', 'const', 'minLength', 'pattern', 'minimum', 'minItems', 'uniqueItems',
    'items', 'properties', 'required', 'additionalProperties', 'oneOf',
  ]);
  const primitive = (value: unknown) => value === null || ['string', 'number', 'boolean'].includes(typeof value);
  const fail = (path: string, message: string) => errors.push(`${label}${path}: ${message}`);
  function inspect(value: unknown, path: string): void {
    if (!isObject(value)) { fail(path, 'expected a schema object'); return; }
    nodes.push(value);
    for (const key of Object.keys(value)) if (!supported.has(key)) fail(path, `unsupported schema keyword ${key}`);
    if (value.type !== undefined && (typeof value.type !== 'string' || !['object', 'array', 'string', 'number', 'boolean', 'null'].includes(value.type))) {
      fail(path, 'unsupported schema type');
    }
    if (value.$ref !== undefined) {
      if (typeof value.$ref !== 'string' || !/^#\/\$defs\/[^/]+$/.test(value.$ref) || !Object.hasOwn(definitions, value.$ref.slice(8))) {
        fail(path, 'schema reference must resolve to a local root definition');
      }
      const assertions = Object.keys(value).filter(key => !['$ref', '$defs', '$schema', '$id', '$comment', 'title', 'description', 'default', 'examples'].includes(key));
      if (assertions.length) fail(path, 'schema reference must not carry sibling assertions');
    }
    if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.length || value.enum.some(item => !primitive(item)))) fail(path, 'schema enum requires primitive values');
    if (value.const !== undefined && !primitive(value.const)) fail(path, 'schema const requires a primitive value');
    for (const keyword of ['minLength', 'minItems']) {
      if (value[keyword] !== undefined && (typeof value[keyword] !== 'number' || !Number.isInteger(value[keyword]) || Number(value[keyword]) < 0)) fail(path, `${keyword} requires a nonnegative integer`);
    }
    if (value.minimum !== undefined && (typeof value.minimum !== 'number' || !Number.isFinite(value.minimum))) fail(path, 'minimum requires a finite number');
    for (const keyword of ['uniqueItems', 'additionalProperties']) {
      if (value[keyword] !== undefined && typeof value[keyword] !== 'boolean') fail(path, `${keyword} requires a boolean`);
    }
    if (value.pattern !== undefined) {
      if (typeof value.pattern !== 'string') fail(path, 'pattern requires a string');
      else { try { new RegExp(value.pattern); } catch { fail(path, 'invalid schema pattern'); } }
    }
    if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some(item => typeof item !== 'string'))) fail(path, 'required must contain field names');
    for (const keyword of ['properties', '$defs']) {
      if (value[keyword] === undefined) continue;
      if (!isObject(value[keyword])) { fail(path, `${keyword} requires an object`); continue; }
      for (const [name, schema] of Object.entries(value[keyword])) inspect(schema, `${path}.${keyword}.${name}`);
    }
    if (value.items !== undefined) inspect(value.items, `${path}.items`);
    if (value.oneOf !== undefined) {
      if (!Array.isArray(value.oneOf) || !value.oneOf.length) fail(path, 'oneOf requires schema branches');
      else value.oneOf.forEach((schema, index) => inspect(schema, `${path}.oneOf[${index}]`));
    }
  }
  inspect(root, '');
  const visiting = new Set<unknown>();
  const visited = new Set<unknown>();
  function visit(node: Record<string, unknown>): void {
    if (visiting.has(node)) { fail('', 'cyclic schema reference does not consume a field or array item'); return; }
    if (visited.has(node)) return;
    visiting.add(node);
    if (typeof node.$ref === 'string') {
      const target = definitions[node.$ref.slice(8)];
      if (isObject(target)) visit(target);
    }
    if (Array.isArray(node.oneOf)) for (const branch of node.oneOf) if (isObject(branch)) visit(branch);
    visiting.delete(node);
    visited.add(node);
  }
  nodes.forEach(visit);
  return errors;
}
