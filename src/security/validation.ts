/** Treat every message crossing a page/extension boundary as untrusted. */
export type RecordValue = Record<string, unknown>;
export function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function boundedData(value: unknown, maxChars = 16 * 1024 * 1024): boolean {
  const stack: Array<[unknown, number, boolean?]> = [[value, 0]];
  const visited = new Set<object>();
  let nodes = 0;
  let chars = 0;
  while (stack.length) {
    const [item, depth, exit] = stack.pop()!;
    if (exit) { visited.delete(item as object); continue; }
    if (++nodes > 100_000 || depth > 64) return false;
    if (typeof item === 'string') chars += item.length;
    else if (typeof item === 'number' && !Number.isFinite(item)) return false;
    else if (typeof item === 'object' && item !== null) {
      if (visited.has(item)) return false;
      visited.add(item);
      stack.push([item, depth, true]);
      if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;
      for (const key of Object.keys(item)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') return false;
        chars += key.length;
        stack.push([(item as RecordValue)[key], depth + 1]);
      }
    } else if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') return false;
    if (chars > maxChars) return false;
  }
  return true;
}
