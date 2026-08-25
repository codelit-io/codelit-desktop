export interface BotOutcomeCapabilities {
  approvedComputerAppName?: string;
  browserReadAvailable: boolean;
  connectedToolCount: number;
  hasProject: boolean;
  schedulesAvailable: boolean;
  teammateCount?: number;
}

interface BotThreadBlock {
  type: string;
  text?: string;
  status?: string;
}

export interface BotOutcomeSignal {
  request: string;
  repeatCount: number;
  status: "completed" | "failed" | "paused";
}

export interface BotOutcomeAction {
  id: string;
  label: string;
  prompt: string;
}

const MAX_ACTIONS = 3;
const MAX_REQUEST_CHARS = 1_200;
const CONTROL_REQUEST = /^(?:every\s+|daily\b|when(?:ever)?\s+(?:this|the)\s+(?:project|folder|repository|repo)\s+changes?|watch\s+(?:this|the)\s+(?:project|folder|repository|repo)\b|set\s+(?:your\s+|the\s+)?goal\b|teach\s+|remember\b|what\s+do\s+you\s+know|(?:show|list|open|export)\s+.+?(?:routines?|skills?|memor(?:y|ies)|tables?|connected tools?)\b|(?:create|make)\s+(?:a\s+)?(?:local\s+)?table\b|(?:ask|have)\s+(?:the\s+)?team\b)/i;

function boundedRequest(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_REQUEST_CHARS).trim();
}

function hasWebsite(value: string) {
  return /https:\/\/[^\s]+/i.test(value);
}

function projectRequest(value: string) {
  return /\b(?:project|codebase|code base|repository|repo|folder|files?)\b/i.test(value);
}

function reusableSkillName(value: string) {
  const words = value
    .replace(/https:\/\/\S+/gi, "")
    .replace(/[^a-z0-9\s-]/gi, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !/^(?:the|this|that|with|from|into|using|only|what|tell|show|please)$/i.test(word))
    .slice(0, 4);
  return words.length ? words.map((word) => `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}`).join(" ") : "Reusable Task";
}

export function buildBotStarterOutcomes(capabilities: BotOutcomeCapabilities): BotOutcomeAction[] {
  const actions: BotOutcomeAction[] = [];
  if (capabilities.hasProject) {
    actions.push({
      id: "project-gap",
      label: "Find the riskiest project gap",
      prompt: "Inspect this project and tell me the highest-impact next step.",
    });
  }
  if (capabilities.teammateCount) {
    actions.push({
      id: "team-review",
      label: `Ask ${capabilities.teammateCount === 1 ? "a teammate" : "the team"}`,
      prompt: capabilities.hasProject
        ? "Ask the team to review this project and return the two highest-risk gaps with evidence."
        : "Ask the team to challenge my current goal and return the two highest-impact next steps.",
    });
  }
  if (capabilities.approvedComputerAppName) {
    actions.push({
      id: "computer-review",
      label: `Review ${capabilities.approvedComputerAppName}`,
      prompt: `Inspect ${capabilities.approvedComputerAppName} and summarize what is visible without changing anything.`,
    });
  }
  if (capabilities.browserReadAvailable) {
    actions.push({
      id: "website-audit",
      label: "Audit a live website",
      prompt: "Inspect https://codelit.io and identify the most important usability issue using only visible evidence.",
    });
  }
  if (capabilities.connectedToolCount > 0) {
    actions.push({
      id: "connected-tools",
      label: `Review ${capabilities.connectedToolCount} connected ${capabilities.connectedToolCount === 1 ? "tool" : "tools"}`,
      prompt: "Show which connected tools are ready and what each one can do.",
    });
  }
  if (capabilities.schedulesAvailable && capabilities.hasProject) {
    actions.push({
      id: "project-watch",
      label: "Watch this project for changes",
      prompt: "When this project changes, summarize what changed and report only material differences.",
    });
  }
  actions.push({
    id: "goal-plan",
    label: "Turn a goal into a plan",
    prompt: "Turn my goal into a small, verifiable plan.",
  });
  actions.push({
    id: "local-tracker",
    label: "Create a local work tracker",
    prompt: "Create a table called Work Tracker with columns Task, Owner, Status, Next step.",
  });
  actions.push({
    id: "review-memory",
    label: "Review what this bot remembers",
    prompt: "What do you know?",
  });
  return actions.slice(0, MAX_ACTIONS);
}

export function latestCompletedBotRequest(blocks: readonly BotThreadBlock[]) {
  const signal = latestBotOutcome(blocks);
  return signal?.status === "completed" ? signal.request : null;
}

export function latestBotOutcome(blocks: readonly BotThreadBlock[]): BotOutcomeSignal | null {
  let request = "";
  let status: BotOutcomeSignal["status"] | null = null;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.type === "user-message") {
      request = boundedRequest(block.text || "");
      break;
    }
    if (block.type === "assistant-message" || block.type === "receipt" || (block.type === "run" && block.status === "completed")) {
      status ||= "completed";
    }
    if (block.type === "error" || (block.type === "run" && ["failed", "stopped"].includes(block.status || ""))) {
      status = "failed";
    }
    if (block.type === "run" && ["paused", "approval-required"].includes(block.status || "")) {
      status = "paused";
    }
  }
  if (!request || !status) return null;
  const normalized = request.toLowerCase();
  const repeatCount = blocks.filter((block) => (
    block.type === "user-message" && boundedRequest(block.text || "").toLowerCase() === normalized
  )).length;
  return { request, repeatCount, status };
}

export function buildBotNextActions(
  requestValue: string | null,
  capabilities: Pick<BotOutcomeCapabilities, "hasProject" | "schedulesAvailable">,
  repeatCount = 1,
): BotOutcomeAction[] {
  const request = boundedRequest(requestValue || "");
  if (!request || request.length < 12 || CONTROL_REQUEST.test(request)) return [];
  const actions: BotOutcomeAction[] = [];
  if (capabilities.schedulesAvailable && hasWebsite(request)) {
    actions.push({
      id: "monitor-weekdays",
      label: repeatCount > 1 ? "Keep doing this" : "Monitor every weekday",
      prompt: `Every weekday at 9 AM, ${request}`,
    });
    actions.push({
      id: "save-skill",
      label: "Save as a skill",
      prompt: `Teach this as a skill called ${reusableSkillName(request)}`,
    });
    return actions;
  }
  if (capabilities.schedulesAvailable && capabilities.hasProject && projectRequest(request)) {
    actions.push({
      id: "watch-project",
      label: "Watch project changes",
      prompt: `When this project changes, ${request}`,
    });
    actions.push({
      id: "make-goal",
      label: "Make this the goal",
      prompt: `Set your goal to ${request}`,
    });
    return actions;
  }
  actions.push({
    id: "make-goal",
    label: "Make this the goal",
    prompt: `Set your goal to ${request}`,
  });
  actions.push({
    id: "save-skill",
    label: "Save as a skill",
    prompt: `Teach this as a skill called ${reusableSkillName(request)}`,
  });
  return actions.slice(0, 2);
}

export function buildBotRecoveryActions(signal: BotOutcomeSignal | null): BotOutcomeAction[] {
  if (!signal || signal.status === "completed" || CONTROL_REQUEST.test(signal.request)) return [];
  const request = boundedRequest(signal.request);
  if (!request) return [];
  return [
    {
      id: "retry-read-only",
      label: "Retry one safe step",
      prompt: `Retry this by taking only the smallest useful read-only step: ${request}`,
    },
    {
      id: "explain-blocker",
      label: "Explain the blocker",
      prompt: `Explain the exact blocker for this request without taking another action: ${request}`,
    },
  ];
}
