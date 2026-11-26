import { ProductError } from './access.js';
import type { JsonValue } from './store.js';

/** Reject ambiguous acceptance scenarios before handing the brief to engineering. */
export function requireChangeBrief(payload: Record<string, JsonValue>) {
  const invalid = () => new ProductError(422, 'invalid_change_brief', 'The change brief needs a clear scope and distinct acceptance scenarios with expected outcomes.');
  if (typeof payload.scope !== 'string' || !payload.scope.trim() || !Array.isArray(payload.scenarios) ||
      !payload.scenarios.length || payload.scenarios.length > 200) throw invalid();
  const ids = new Set<string>();
  for (const item of payload.scenarios) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' ||
        !item.id.trim() || item.id !== item.id.trim() || item.id.length > 200 || ids.has(item.id) ||
        typeof item.expected !== 'string' || !item.expected.trim() || item.expected.length > 4000) throw invalid();
    ids.add(item.id);
  }
}
