import { create, createStore, type StateCreator, type StoreApi } from "zustand";
import { persist } from "zustand/middleware";

export interface ProductCard {
  id: string;
  type: "feature" | "user-story" | "screen" | "milestone" | "requirement";
  title: string;
  description: string;
  priority: "must-have" | "should-have" | "nice-to-have";
  status: "idea" | "defined" | "building" | "done";
  /** Figma frame ID: links this card to a specific Figma frame */
  figmaFrameId?: string;
  /** Figma thumbnail URL: rendered on screen cards instead of SVG wireframe */
  figmaThumbUrl?: string;
  /** Figma file URL: click to open in Figma */
  figmaFileUrl?: string;
}

export interface ProductFlow {
  id: string;
  from: string;
  to: string;
  label: string;
}

export interface ProductBoard {
  title: string;
  description: string;
  targetAudience: string;
  cards: ProductCard[];
  flows: ProductFlow[];
}

export interface ProductBoardStore {
  board: ProductBoard | null;
  isGenerating: boolean;
  selectedCard: ProductCard | null;

  setBoard: (board: ProductBoard) => void;
  setDraftSlug: (slug: string | null) => void;
  draftSlug: string | null;
  clearBoard: () => void;
  setGenerating: (generating: boolean) => void;
  setSelectedCard: (card: ProductCard | null) => void;

  addCard: (card: ProductCard) => void;
  updateCard: (id: string, updates: Partial<ProductCard>) => void;
  removeCard: (id: string) => void;

  addFlow: (flow: ProductFlow) => void;
  removeFlow: (id: string) => void;

  // Convert board to architecture prompt
  toArchitecturePrompt: () => string;
  // Convert board to an agent-workflow generation prompt
  toAgentWorkflowPrompt: () => string;
}

function createProductBoardState(
  initialBoard: ProductBoard | null = null,
): StateCreator<ProductBoardStore> {
  return (set, get) => ({
  board: initialBoard,
  isGenerating: false,
  selectedCard: null,

  setBoard: (board) => set({ board }),
  setDraftSlug: (slug) => set({ draftSlug: slug }),
  draftSlug: null,
  clearBoard: () => set({ board: null, selectedCard: null, draftSlug: null }),
  setGenerating: (generating) => set({ isGenerating: generating }),
  setSelectedCard: (card) => set({ selectedCard: card }),

  addCard: (card) => {
    const { board } = get();
    if (!board) return;
    set({ board: { ...board, cards: [...board.cards, card] } });
  },

  updateCard: (id, updates) => {
    const { board } = get();
    if (!board) return;
    set({
      board: {
        ...board,
        cards: board.cards.map(c => c.id === id ? { ...c, ...updates } : c),
      },
    });
  },

  removeCard: (id) => {
    const { board } = get();
    if (!board) return;
    set({
      board: {
        ...board,
        cards: board.cards.filter(c => c.id !== id),
        flows: board.flows.filter(f => f.from !== id && f.to !== id),
      },
    });
  },

  addFlow: (flow) => {
    const { board } = get();
    if (!board) return;
    set({ board: { ...board, flows: [...board.flows, flow] } });
  },

  removeFlow: (id) => {
    const { board } = get();
    if (!board) return;
    set({ board: { ...board, flows: board.flows.filter(f => f.id !== id) } });
  },

  toArchitecturePrompt: () => {
    const { board } = get();
    if (!board) return "";
    let prompt = `Generate a system architecture for "${board.title}".\n\n`;
    prompt += `Description: ${board.description}\n`;
    prompt += `Target Audience: ${board.targetAudience}\n\n`;

    const features = board.cards.filter(c => c.type === "feature");
    if (features.length > 0) {
      prompt += `Features:\n`;
      for (const card of features) prompt += `- [${card.priority}] ${card.title}: ${card.description}\n`;
      prompt += `\n`;
    }

    const screens = board.cards.filter(c => c.type === "screen");
    if (screens.length > 0) {
      prompt += `Screens/Pages:\n`;
      for (const card of screens) {
        prompt += `- ${card.title}: ${card.description}`;
        if (card.figmaFrameId) prompt += ` [Figma frame: ${card.figmaFrameId}]`;
        prompt += `\n`;
      }
      const figmaScreens = screens.filter(s => s.figmaFrameId);
      if (figmaScreens.length > 0) {
        prompt += `\nNote: ${figmaScreens.length} screens are linked to Figma designs. Use these as reference for frontend component architecture.\n`;
      }
      prompt += `\n`;
    }

    const stories = board.cards.filter(c => c.type === "user-story");
    if (stories.length > 0) {
      prompt += `User Stories:\n`;
      for (const card of stories) prompt += `- ${card.title}\n`;
      prompt += `\n`;
    }

    const reqs = board.cards.filter(c => c.type === "requirement");
    if (reqs.length > 0) {
      prompt += `Requirements:\n`;
      for (const card of reqs) prompt += `- ${card.title}: ${card.description}\n`;
      prompt += `\n`;
    }

    prompt += `Design the full system architecture including services, databases, APIs, and integrations to support all these features, screens, and requirements.`;
    return prompt;
  },

  toAgentWorkflowPrompt: () => {
    const { board } = get();
    if (!board) return "";
    let prompt = `Design an AI agent workflow to build "${board.title}".\n\n`;
    if (board.description) prompt += `Description: ${board.description}\n`;
    const features = board.cards.filter((c) => c.type === "feature");
    if (features.length > 0) {
      prompt += `\nFeatures the workflow should deliver:\n`;
      for (const card of features) prompt += `- ${card.title}: ${card.description}\n`;
    }
    return prompt;
  },
  });
}

export type ProductBoardStoreApi = StoreApi<ProductBoardStore>;

export function createProductBoardStore(initialBoard: ProductBoard | null = null) {
  return createStore<ProductBoardStore>()(createProductBoardState(initialBoard));
}

export const useProductBoardStore = create<ProductBoardStore>()(persist(createProductBoardState(), {
  name: "codelit-board-draft",
  partialize: (state) => ({ board: state.board, draftSlug: state.draftSlug }),
}));
