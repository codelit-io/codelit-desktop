function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Only plain JSON objects can be canonicalized");
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

/** Stable JSON for version identities and immutable execution snapshots. */
export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalValue(value));
  if (typeof serialized !== "string") throw new Error("Value is not JSON serializable");
  return serialized;
}

/** Removes prototypes and undefined values while preserving canonical key order. */
export function cloneCanonicalJson<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}
