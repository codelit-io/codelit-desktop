import type {
  ThreadBlock,
  WorkspaceArtifactRef,
  WorkspaceThread,
} from "./workspace-thread";

export type WorkspaceApprovalBlock = Extract<ThreadBlock, { type: "approval" }>;
export type WorkspaceReceiptBlock = Extract<ThreadBlock, { type: "receipt" }>;

export interface LocalArtifactVersion {
  artifactId: string;
  kind: WorkspaceArtifactRef["kind"];
  version: string;
  title: string;
  projectId: string;
  payload: unknown;
  createdAt: string;
}

export interface LocalRunEvent {
  runId: string;
  sequence: number;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

export interface LocalReceipt {
  id: string;
  runId: string;
  artifactId: string;
  body: unknown;
  createdAt: string;
}

export interface LocalRunCheckpoint {
  runId: string;
  stepIndex: number;
  body: unknown;
  updatedAt: string;
}

export interface LocalRunApproval {
  id: string;
  runId: string;
  stepIndex: number;
  status: "awaiting" | "approved" | "held" | "edit" | "denied";
  body: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface LocalArtifactFile {
  artifactId: string;
  hash: string;
  fileName: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface LocalWorkspaceFolder {
  path: string;
  readOnly: boolean;
  stale: boolean;
  accessValidated: boolean;
  updatedAt: string;
}

export interface LocalWorkspaceSnapshot {
  thread: WorkspaceThread;
  blocks: ThreadBlock[];
  artifacts: LocalArtifactVersion[];
  runEvents: LocalRunEvent[];
  runCheckpoints: LocalRunCheckpoint[];
  approvals: LocalRunApproval[];
  receipts: LocalReceipt[];
  artifactFiles: LocalArtifactFile[];
  workspaceFolder: LocalWorkspaceFolder | null;
  databasePath: string;
}
