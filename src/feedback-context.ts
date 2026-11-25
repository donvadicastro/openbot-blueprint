/** Keep recent role guidance useful without letting project memory consume an unbounded turn. */
export function boundGuidance<T extends { guidance: string }>(entries: T[], maxChars = 8000, maxEntries = 20) {
  const selected: T[] = [];
  let chars = 0;
  for (const entry of [...entries].reverse()) {
    const cost = entry.guidance.length;
    if (selected.length >= maxEntries || chars + cost > maxChars) break;
    selected.push(entry);
    chars += cost;
  }
  selected.reverse();
  return { entries: selected, omitted: entries.length - selected.length };
}
