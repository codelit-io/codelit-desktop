import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  AI_PROVIDERS,
  AVAILABLE_MODELS,
  DEFAULT_MODEL_ID,
  getModelById,
  isKnownUnavailableModelId,
  mergeModelCatalogs,
  replaceProviderModels,
  type AIModel,
  type AIProvider,
} from "../lib/ai-models";

export type { AIModel, AIProvider } from "../lib/ai-models";
export { AVAILABLE_MODELS } from "../lib/ai-models";

interface SettingsState {
  openRouterKey: string;
  openaiKey: string;
  anthropicKey: string;
  geminiKey: string;
  providerKeys: Partial<Record<AIProvider, string>>;
  selectedModelId: string;
  availableModels: AIModel[];
  lastModelRefreshAt: number | null;
  modelRefreshAtByProvider: Partial<Record<AIProvider, number>>;
  desktopTaskNotifications: boolean;
  emailTaskNotifications: boolean;
  setOpenRouterKey: (key: string) => void;
  setOpenaiKey: (key: string) => void;
  setAnthropicKey: (key: string) => void;
  setGeminiKey: (key: string) => void;
  setProviderKey: (provider: AIProvider, key: string) => void;
  getProviderKey: (provider: AIProvider) => string;
  clearProviderKeys: () => void;
  setSelectedModelId: (id: string) => void;
  setAvailableModels: (models: AIModel[]) => void;
  setProviderModels: (provider: AIProvider, models: AIModel[]) => void;
  setDesktopTaskNotifications: (enabled: boolean) => void;
  setEmailTaskNotifications: (enabled: boolean) => void;
  getSelectedModel: () => AIModel;
}

export function migrateSettingsState(persisted: unknown) {
  if (!persisted || typeof persisted !== "object" || Array.isArray(persisted)) return {};
  const next = { ...(persisted as Record<string, unknown>) };
  delete next.webhookUrl;
  return next;
}

function allProviderRefreshTimes(refreshedAt: number) {
  return Object.fromEntries(
    AI_PROVIDERS.map((provider) => [provider, refreshedAt]),
  ) as Partial<Record<AIProvider, number>>;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      openRouterKey: "",
      openaiKey: "",
      anthropicKey: "",
      geminiKey: "",
      providerKeys: {},
      selectedModelId: DEFAULT_MODEL_ID,
      availableModels: AVAILABLE_MODELS,
      lastModelRefreshAt: null,
      modelRefreshAtByProvider: {},
      desktopTaskNotifications: false,
      emailTaskNotifications: true,
      setOpenRouterKey: (key) => set((state) => ({ openRouterKey: key, providerKeys: { ...state.providerKeys, openrouter: key } })),
      setOpenaiKey: (key) => set((state) => ({ openaiKey: key, providerKeys: { ...state.providerKeys, openai: key } })),
      setAnthropicKey: (key) => set((state) => ({ anthropicKey: key, providerKeys: { ...state.providerKeys, anthropic: key } })),
      setGeminiKey: (key) => set((state) => ({ geminiKey: key, providerKeys: { ...state.providerKeys, gemini: key } })),
      setProviderKey: (provider, key) => set((state) => ({
        providerKeys: { ...state.providerKeys, [provider]: key },
        ...(provider === "openrouter" ? { openRouterKey: key } : {}),
        ...(provider === "openai" ? { openaiKey: key } : {}),
        ...(provider === "anthropic" ? { anthropicKey: key } : {}),
        ...(provider === "gemini" ? { geminiKey: key } : {}),
      })),
      getProviderKey: (provider) => {
        const state = get();
        if (state.providerKeys?.[provider]) return state.providerKeys[provider] || "";
        if (provider === "openrouter") return state.openRouterKey;
        if (provider === "openai") return state.openaiKey;
        if (provider === "anthropic") return state.anthropicKey;
        if (provider === "gemini") return state.geminiKey;
        return "";
      },
      clearProviderKeys: () => set({ openRouterKey: "", openaiKey: "", anthropicKey: "", geminiKey: "", providerKeys: {} }),
      setSelectedModelId: (id) => set({ selectedModelId: isKnownUnavailableModelId(id) ? DEFAULT_MODEL_ID : id }),
      setAvailableModels: (models) => set(() => {
        const refreshedAt = Date.now();
        return {
          availableModels: mergeModelCatalogs(AVAILABLE_MODELS, models),
          lastModelRefreshAt: refreshedAt,
          modelRefreshAtByProvider: allProviderRefreshTimes(refreshedAt),
        };
      }),
      setProviderModels: (provider, models) => set((state) => {
        const refreshedAt = Date.now();
        return {
          availableModels: replaceProviderModels(
            state.availableModels?.length ? state.availableModels : AVAILABLE_MODELS,
            provider,
            models,
          ),
          lastModelRefreshAt: refreshedAt,
          modelRefreshAtByProvider: {
            ...state.modelRefreshAtByProvider,
            [provider]: refreshedAt,
          },
        };
      }),
      setDesktopTaskNotifications: (enabled) => set({ desktopTaskNotifications: enabled }),
      setEmailTaskNotifications: (enabled) => set({ emailTaskNotifications: enabled }),
      getSelectedModel: () => {
        const state = get();
        if (isKnownUnavailableModelId(state.selectedModelId)) {
          set({ selectedModelId: DEFAULT_MODEL_ID });
          return getModelById(
            state.availableModels?.length ? state.availableModels : AVAILABLE_MODELS,
            DEFAULT_MODEL_ID,
          );
        }

        return getModelById(
          state.availableModels?.length ? state.availableModels : AVAILABLE_MODELS,
          state.selectedModelId,
        );
      },
    }),
    {
      name: "codelit-settings",
      version: 3,
      migrate: migrateSettingsState,
      partialize: (state) => ({
        openRouterKey: state.openRouterKey,
        openaiKey: state.openaiKey,
        anthropicKey: state.anthropicKey,
        geminiKey: state.geminiKey,
        providerKeys: state.providerKeys,
        selectedModelId: state.selectedModelId,
        availableModels: state.availableModels,
        lastModelRefreshAt: state.lastModelRefreshAt,
        modelRefreshAtByProvider: state.modelRefreshAtByProvider,
        desktopTaskNotifications: state.desktopTaskNotifications,
        emailTaskNotifications: state.emailTaskNotifications,
      }),
    }
  )
);
