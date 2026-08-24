export function slugifyAgentWorkflow(value: string, fallback = "agent-workflow") {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    || fallback;
}
