export type LocalFileIntent =
  | { kind: "list-folder"; purpose: "desktop" | "project" }
  | { kind: "read-project-file"; path: string }
  | { kind: "describe-project" };

export function projectFileReference(value: string) {
  const match = value.match(/\b(?:read|quote)\s+(?:the\s+)?(?:file\s+)?(["'`]?)([a-z0-9_./-]+\.[a-z0-9]+)\1\s+(?:from|in|inside|within)\s+(?:(?:the|my)\s+)?(?:(?:connected|selected|approved|local)\s+)?(?:project|repository|repo|codebase)\b/i);
  if (!match) return null;
  const path = match[2];
  const start = match.index! + match[0].indexOf(path);
  return { path, start, end: start + path.length };
}

function normalizedRequest(value: string) {
  return value.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
}

export function localConversationReply(value: string, botName: string) {
  const request = normalizedRequest(value).replace(/[!.?]+$/g, "").trim();
  if (/^(?:hi|hello|hey|good morning|good afternoon|good evening)(?:,?\s+(?:what can you (?:do|help me with)|how can you help|who are you))?$/.test(request)) {
    return `Hi! I'm ${botName}. What should we work on?`;
  }
  if (/^(?:thanks|thank you|thank you very much)$/.test(request)) {
    return "You're welcome. What should we work on next?";
  }
  return null;
}

export function parseLocalFileIntent(value: string): LocalFileIntent | null {
  const file = projectFileReference(value);
  if (file) return { kind: "read-project-file", path: file.path };
  const request = normalizedRequest(value);
  if (!request) return null;

  const mentionsDesktop = /\b(?:my|the|your)?\s*desktop\b/.test(request);
  const asksForListing = /\b(?:check|inspect|list|look|show|tell)\b/.test(request)
    && /\b(?:files?|folders?|items?|contents?|what)\b/.test(request);
  if (mentionsDesktop && asksForListing) {
    return { kind: "list-folder", purpose: "desktop" };
  }

  const mentionsProject = /\b(?:codebase|code base|repository|repo|project)\b/.test(request);
  const asksForOverview = /\b(?:what(?:'s| is)|about|summari[sz]e|overview|explain|understand|describe)\b/.test(request);
  if (mentionsProject && asksForOverview) {
    return { kind: "describe-project" };
  }

  const asksForProjectListing = /\b(?:list|show|check|inspect)\b/.test(request)
    && /\b(?:project|repository|repo)\s+(?:files?|folders?|contents?|items?)\b/.test(request);
  return asksForProjectListing ? { kind: "list-folder", purpose: "project" } : null;
}

export function selectedFolderMatchesPurpose(path: string | undefined, purpose: "desktop" | "project") {
  if (!path) return false;
  const folderName = path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1)?.toLowerCase();
  return purpose === "desktop" ? folderName === "desktop" : folderName !== "desktop";
}
