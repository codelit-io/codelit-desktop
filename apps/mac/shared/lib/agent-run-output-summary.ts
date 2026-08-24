function normalizedOutput(value: string) {
  return value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function structuredKeys(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.keys(parsed as Record<string, unknown>).slice(0, 4);
  } catch {
    return [];
  }
}

function boundedSentence(value: string, max: number) {
  if (value.length <= max) return value;
  const punctuation = Math.max(
    value.lastIndexOf(". ", max),
    value.lastIndexOf("; ", max),
    value.lastIndexOf(", ", max),
  );
  const space = value.lastIndexOf(" ", max - 1);
  const end = punctuation >= Math.floor(max * 0.55) ? punctuation + 1 : space >= Math.floor(max * 0.55) ? space : max - 1;
  return `${value.slice(0, end).trimEnd()}…`;
}

export function agentRunStreamPreview(value: string, max = 160) {
  const normalized = normalizedOutput(value);
  if (!normalized) return "Preparing output…";
  const keys = structuredKeys(normalized);
  if (keys.length) return `Structured result ready: ${keys.join(", ")}`;
  if (normalized.startsWith("{") || normalized.startsWith("[")) return "Building structured result…";
  return boundedSentence(normalized, max);
}

export function agentRunArtifactSummary(value: string, max = 96) {
  const normalized = normalizedOutput(value);
  if (!normalized) return "step output ready";
  const keys = structuredKeys(normalized);
  if (keys.length) return `structured result: ${keys.join(", ")}`;
  return boundedSentence(normalized, max);
}
