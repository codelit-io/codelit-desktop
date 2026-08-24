import { create, createStore, type StateCreator, type StoreApi } from "zustand";
import type { SystemArchitecture, SystemNode } from "../lib/system-parser";

export interface CanvasState {
  architecture: SystemArchitecture | null;
  draftSlug: string | null;
  selectedNode: SystemNode | null;
  activeProjectId: string | null;
  activeProjectTitle: string | null;
  isGenerating: boolean;
  generatingProgress: number;
  failedNodes: Set<string>;
  chaosMode: boolean;
  setArchitecture: (arch: SystemArchitecture) => void;
  setDraftSlug: (slug: string | null) => void;
  setActiveProject: (projectId: string | null, title?: string | null) => void;
  setSelectedNode: (node: SystemNode | null) => void;
  setIsGenerating: (val: boolean) => void;
  setGeneratingProgress: (val: number) => void;
  toggleNodeFailure: (nodeId: string) => void;
  simulateCascadingFailure: (nodeId: string) => void;
  setChaosMode: (val: boolean) => void;
  resetFailures: () => void;
  annotations: Record<string, string>;
  setAnnotation: (nodeId: string, text: string) => void;
  removeAnnotation: (nodeId: string) => void;
  reset: () => void;
  toBoardPrompt: () => string;
  toAgentWorkflowPrompt: () => string;
}

export interface CanvasStoreSeed {
  architecture?: SystemArchitecture | null;
  annotations?: Record<string, string>;
}

/** Find all nodes downstream of a given node via edges */
function findDownstream(nodeId: string, edges: { from: string; to: string }[], visited = new Set<string>()): Set<string> {
  visited.add(nodeId);
  for (const edge of edges) {
    if (edge.from === nodeId && !visited.has(edge.to)) {
      findDownstream(edge.to, edges, visited);
    }
  }
  return visited;
}

export function createCanvasState(seed: CanvasStoreSeed = {}): StateCreator<CanvasState> {
  const initialArchitecture = seed.architecture || null;
  const initialAnnotations = { ...(seed.annotations || {}) };
  return (set, get) => ({
  architecture: initialArchitecture,
  draftSlug: null,
  selectedNode: null,
  activeProjectId: null,
  activeProjectTitle: null,
  isGenerating: false,
  generatingProgress: 0,
  failedNodes: new Set(),
  chaosMode: false,
  setArchitecture: (architecture) => set({ architecture, failedNodes: new Set(), chaosMode: false }),
  setDraftSlug: (draftSlug) => set({ draftSlug }),
  setActiveProject: (activeProjectId, activeProjectTitle = null) => set({ activeProjectId, activeProjectTitle }),
  setSelectedNode: (selectedNode) => set({ selectedNode }),
  setIsGenerating: (isGenerating) => set({ isGenerating, generatingProgress: isGenerating ? 0 : 100 }),
  setGeneratingProgress: (generatingProgress) => set({ generatingProgress }),
  toggleNodeFailure: (nodeId) =>
    set((state) => {
      const next = new Set(state.failedNodes);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return { failedNodes: next };
    }),
  simulateCascadingFailure: (nodeId) => {
    const { architecture } = get();
    if (!architecture) return;

    const allAffected = findDownstream(nodeId, architecture.edges);
    const affected = [...allAffected];

    // Animate cascade: fail nodes one by one with delay
    set({ failedNodes: new Set([nodeId]) });
    affected.forEach((id, i) => {
      if (id === nodeId) return;
      setTimeout(() => {
        set((state) => {
          const next = new Set(state.failedNodes);
          next.add(id);
          return { failedNodes: next };
        });
      }, (i) * 300);
    });
  },
  setChaosMode: (chaosMode) => set({ chaosMode, failedNodes: chaosMode ? new Set() : new Set() }),
  resetFailures: () => set({ failedNodes: new Set(), chaosMode: false }),
  annotations: initialAnnotations,
  setAnnotation: (nodeId, text) => set((s) => ({
    annotations: { ...s.annotations, [nodeId]: text },
  })),
  removeAnnotation: (nodeId) => set((s) => {
    const next = { ...s.annotations };
    delete next[nodeId];
    return { annotations: next };
  }),
  reset: () => set({ architecture: initialArchitecture, draftSlug: null, selectedNode: null, activeProjectId: null, activeProjectTitle: null, failedNodes: new Set(), chaosMode: false, annotations: initialAnnotations, isGenerating: false, generatingProgress: 0 }),

  // Mirror of product-board-store.toArchitecturePrompt: build a product-board
  // generation prompt from the current architecture, for the arch → board flip.
  toBoardPrompt: () => {
    const { architecture } = get();
    if (!architecture) return "";
    let prompt = `Generate a product plan for "${architecture.title}".\n\n`;
    if (architecture.description) prompt += `Description: ${architecture.description}\n\n`;
    if (architecture.nodes.length > 0) {
      prompt += `System components:\n`;
      for (const node of architecture.nodes) {
        prompt += `- ${node.label}${node.type ? ` (${node.type})` : ""}${node.description ? `: ${node.description}` : ""}\n`;
      }
      prompt += `\n`;
    }
    if (architecture.edges.length > 0) {
      prompt += `Data flows:\n`;
      for (const edge of architecture.edges) {
        prompt += `- ${edge.from} to ${edge.to}${edge.label ? `: ${edge.label}` : ""}\n`;
      }
    }
    return prompt;
  },

  // arch -> agent workflow: build an agent-workflow generation prompt from the
  // current architecture, for the toolbar switcher's generate-if-missing path.
  toAgentWorkflowPrompt: () => {
    const { architecture } = get();
    if (!architecture) return "";
    let prompt = `Design an AI agent workflow for the system "${architecture.title}".\n\n`;
    if (architecture.description) prompt += `Description: ${architecture.description}\n\n`;
    if (architecture.nodes.length > 0) {
      prompt += `System components the agents can operate on:\n`;
      for (const node of architecture.nodes) {
        prompt += `- ${node.label}${node.type ? ` (${node.type})` : ""}\n`;
      }
    }
    return prompt;
  },
  });
}

export type CanvasStoreApi = StoreApi<CanvasState>;

export function createCanvasStore(seed: CanvasStoreSeed = {}) {
  return createStore<CanvasState>()(createCanvasState(seed));
}

export const useCanvasStore = create<CanvasState>()(createCanvasState());
