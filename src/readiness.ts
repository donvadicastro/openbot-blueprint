export interface ReadinessField {
  id: string;
  stage: 'intake' | 'assignment';
  instruction: string;
  question?: string;
  format?: 'folder' | 'project-source';
}

export function isReadinessAnswer(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && !/^(unknown|pending|unverified|none|n\/a|tbd|todo)$/i.test(value.trim());
}

/** A handoff carries named facts. The receiving bot still has to verify any claimed access. */
export function handoffReadinessError(fields: ReadinessField[] | undefined, constraints?: string): string | undefined {
  if (!fields?.length) return;
  let values: unknown;
  try { values = JSON.parse(constraints ?? ''); }
  catch { return 'Provide the readiness values as a JSON object in constraints.'; }
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    return 'Provide the readiness values as a JSON object in constraints.';
  }
  const missing = fields.filter(({ id }) => {
    const value = Object.hasOwn(values, id) ? (values as Record<string, unknown>)[id] : undefined;
    return !isReadinessAnswer(value);
  });
  if (missing.length) return `Resolve these readiness fields before handing off: ${missing.map(({ id }) => id).join(', ')}.`;
}
