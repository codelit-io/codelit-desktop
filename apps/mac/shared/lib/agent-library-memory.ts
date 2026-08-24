import type { AgentLibraryScope } from "./agent-library-contract";

export const AGENT_MEMORY_BODY_VERSION = 1 as const;

export const AGENT_MEMORY_CATEGORIES = [
  "fact",
  "decision",
  "preference",
  "procedure",
  "lesson",
  "reference",
] as const;
export type AgentMemoryCategory = (typeof AGENT_MEMORY_CATEGORIES)[number];

export const AGENT_MEMORY_IMPORTANCE = ["normal", "important", "pinned"] as const;
export type AgentMemoryImportance = (typeof AGENT_MEMORY_IMPORTANCE)[number];

export const AGENT_MEMORY_SENSITIVITY = ["normal", "restricted"] as const;
export type AgentMemorySensitivity = (typeof AGENT_MEMORY_SENSITIVITY)[number];

export const AGENT_MEMORY_SOURCE_TRUST = [
  "user",
  "reviewed-run",
  "connected-source",
] as const;
export type AgentMemorySourceTrust = (typeof AGENT_MEMORY_SOURCE_TRUST)[number];

export interface AgentMemoryProvenance {
  createdBy: string;
  threadId?: string;
  runId?: string;
  receiptId?: string;
  sourceLabel: string;
  sourceTrust: AgentMemorySourceTrust;
}

export interface AgentMemoryAssetBody {
  version: typeof AGENT_MEMORY_BODY_VERSION;
  text: string;
  category: AgentMemoryCategory;
  importance: AgentMemoryImportance;
  sensitivity: AgentMemorySensitivity;
  expiresAt?: string;
  normalizedHash: string;
  provenance: AgentMemoryProvenance;
}

export interface ManualAgentMemoryInput {
  text: string;
  category: AgentMemoryCategory;
  importance: AgentMemoryImportance;
  sensitivity: AgentMemorySensitivity;
  expiresAt?: string;
}

export interface ReviewedRunAgentMemorySource {
  confirmed: true;
}

export interface AgentMemoryDuplicateCandidate {
  id: string;
  name: string;
  text: string;
  status: "active" | "archived";
  similarity: number;
  exact: boolean;
  scope: AgentLibraryScope;
}

export function normalizeAgentMemoryText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

export function agentMemoryLabel(value: string): string {
  const firstLine = value
    .split(/\r?\n/, 1)[0]
    .replace(/\s+/g, " ")
    .trim();
  if (firstLine.length <= 80) return firstLine;
  return `${firstLine.slice(0, 77).trimEnd()}...`;
}

export function agentMemorySummary(category: AgentMemoryCategory): string {
  return `${category.charAt(0).toUpperCase()}${category.slice(1)} memory`;
}
