import { create } from "zustand";
import { trackEvent } from "../lib/analytics";
import { useCanvasStore } from "./canvas-store";

export type SessionType = "architecture" | "product-board" | "agent-workflow";

export interface Message {
  role: "user" | "assistant";
  content: string;
  code?: string;
  timestamp: number;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  favorited?: boolean;
  type?: SessionType;
  nodeCount?: number;
  cardCount?: number;
  agentCount?: number;
}

interface ChatState {
  messages: Message[];
  code: string;
  isGenerating: boolean;
  title: string;
  chatId: string | null;
  sessions: Session[];
  activeSessionId: string | null;
  addMessage: (msg: Pick<Message, "role" | "content">) => void;
  setCode: (code: string) => void;
  setIsGenerating: (val: boolean) => void;
  setTitle: (title: string) => void;
  setChatId: (id: string) => void;
  extractCode: (markdown: string) => string;
  extractMermaid: (markdown: string) => string;
  newChat: () => void;
  loadSession: (session: Session) => Promise<void>;
  saveCurrentSession: () => void;
  deleteSession: (id: string) => void;
  setActiveSessionId: (id: string | null) => void;
  addSession: (session: Session) => void;
  setSessions: (sessions: Session[]) => void;
  toggleFavorite: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  duplicateSession: (id: string) => Promise<void>;
}

function normalizeSessionType(type: unknown): SessionType {
  if (type === "product-board" || type === "agent-workflow" || type === "architecture") return type;
  return "architecture";
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  code: "",
  isGenerating: false,
  title: "",
  chatId: null,
  sessions: [],
  activeSessionId: null,

  addMessage: (msg) =>
    set((state) => ({
      messages: [
        ...state.messages,
        { ...msg, timestamp: Date.now() },
      ],
    })),

  setCode: (code) => set({ code }),
  setIsGenerating: (isGenerating) => set({ isGenerating }),
  setTitle: (title) => set({ title }),
  setChatId: (id) => set({ chatId: id }),

  extractCode: (markdown: string) => {
    const match = markdown.match(/```(?:jsx|tsx|js|ts|javascript|typescript)?\n([\s\S]*?)```/);
    return match ? match[1].trim() : "";
  },

  extractMermaid: (markdown: string) => {
    const match = markdown.match(/```mermaid\n([\s\S]*?)```/);
    return match ? match[1].trim() : "";
  },

  newChat: () =>
    set({
      messages: [],
      code: "",
      isGenerating: false,
      title: "",
      chatId: null,
      activeSessionId: null,
    }),

  loadSession: async (session) => {
    set({ activeSessionId: session.id, title: session.title, chatId: session.id });
    // Load full messages from Firestore
    try {
      const { doc, getDoc } = await import("firebase/firestore");
      const { db } = await import("../lib/firebase-firestore");
      const snap = await getDoc(doc(db, "sessions", session.id));
      if (snap.exists()) {
        const data = snap.data();
        const type = normalizeSessionType(
          data.type || session.type || (data.productBoardJson ? "product-board" : data.agentWorkflowJson ? "agent-workflow" : "architecture")
        );
        set({ messages: data.messages || [], code: data.code || "" });
        trackEvent("session_restore", { type });

        const { useCanvasStore } = await import("./canvas-store");
        const { useProductBoardStore } = await import("./product-board-store");
        const { useAgentWorkflowStore } = await import("./agent-workflow-store");

        if (type === "product-board" && data.productBoardJson) {
          try {
            const board = JSON.parse(data.productBoardJson);
            useProductBoardStore.getState().setBoard(board);
            useCanvasStore.getState().reset();
            useAgentWorkflowStore.getState().clearWorkflow();
          } catch (e) {
            console.error("Failed to restore product plan:", e);
          }
          return;
        }

        if (type === "agent-workflow" && data.agentWorkflowJson) {
          try {
            const workflow = JSON.parse(data.agentWorkflowJson);
            useAgentWorkflowStore.getState().setWorkflow(workflow);
            useCanvasStore.getState().reset();
            useProductBoardStore.getState().clearBoard();
          } catch (e) {
            console.error("Failed to restore agent workflow:", e);
          }
          return;
        }

        useProductBoardStore.getState().clearBoard();
        useAgentWorkflowStore.getState().clearWorkflow();

        // Restore architecture if saved
        if (data.architectureJson) {
          try {
            const arch = JSON.parse(data.architectureJson);
            useCanvasStore.getState().setArchitecture(arch);
          } catch (e) {
            console.error("Failed to restore architecture:", e);
          }
        } else if (data.messages?.length) {
          // Fallback: try to parse architecture from last assistant message
          try {
            const { parseSystemResponse } = await import("../lib/system-parser");
            const lastAssistant = [...data.messages].reverse().find((m: { role: string }) => m.role === "assistant");
            if (lastAssistant) {
              const parsed = parseSystemResponse(lastAssistant.content);
              if (parsed) useCanvasStore.getState().setArchitecture(parsed);
            }
          } catch { /* ignore */ }
        }
      }
    } catch (err) {
      console.error("Failed to load session:", err);
    }
  },

  saveCurrentSession: () => {
    const state = get();
    if (state.messages.length === 0) return;

    const now = Date.now();
    const id = state.activeSessionId || crypto.randomUUID();
    const existing = state.sessions.find((s) => s.id === id);

    // Grab node count from canvas store
    const nodeCount = useCanvasStore.getState().architecture?.nodes?.length || 0;

    if (existing) {
      set({
        sessions: state.sessions.map((s) =>
          s.id === id ? { ...s, title: state.title || s.title, updatedAt: now, type: "architecture", nodeCount } : s
        ),
        activeSessionId: id,
      });
    } else {
      set({
        sessions: [
          ...state.sessions,
          {
            id,
            title: state.title || "Untitled",
            createdAt: now,
            updatedAt: now,
            type: "architecture",
            nodeCount,
          },
        ],
        activeSessionId: id,
      });
    }
  },

  deleteSession: (id) =>
    set((state) => ({
      sessions: state.sessions.filter((s) => s.id !== id),
      activeSessionId: state.activeSessionId === id ? null : state.activeSessionId,
    })),

  setActiveSessionId: (id) => set({ activeSessionId: id }),

  addSession: (session) => set((state) => ({ sessions: [session, ...state.sessions] })),

  setSessions: (sessions) => set({ sessions }),
  renameSession: (id, title) => set((state) => ({
    sessions: state.sessions.map((s) =>
      s.id === id ? { ...s, title } : s
    ),
  })),
  toggleFavorite: (id) => set((state) => ({
    sessions: state.sessions.map((s) =>
      s.id === id ? { ...s, favorited: !s.favorited } : s
    ),
  })),

  duplicateSession: async (id) => {
    try {
      const { doc, getDoc, setDoc } = await import("firebase/firestore");
      const { db } = await import("../lib/firebase-firestore");
      const snap = await getDoc(doc(db, "sessions", id));
      if (!snap.exists()) return;

      const data = snap.data();
      const newId = crypto.randomUUID();
      const now = Date.now();
      const originalSession = get().sessions.find((s) => s.id === id);
      const duplicateTitle = `${originalSession?.title || data.title || "Untitled"} (copy)`;

      // Save duplicated session to Firestore
      await setDoc(doc(db, "sessions", newId), {
        ...data,
        title: duplicateTitle,
        createdAt: now,
        updatedAt: now,
      });

      // Add to local state
      const newSession: Session = {
        id: newId,
        title: duplicateTitle,
        createdAt: now,
        updatedAt: now,
        type: originalSession?.type,
        nodeCount: originalSession?.nodeCount,
        cardCount: originalSession?.cardCount,
        agentCount: originalSession?.agentCount,
      };
      set((state) => ({ sessions: [newSession, ...state.sessions] }));
    } catch (err) {
      console.error("Failed to duplicate session:", err);
    }
  },
}));
