import { isProviderPackId, type ProviderPackId } from "./provider-packs";
import { isWorkflowConnectorId, type WorkflowConnectorId } from "./workflow-connectors";

export type LiveRunActionProviderId = WorkflowConnectorId | ProviderPackId | "custom";

export function isLiveRunActionProviderId(value: unknown): value is LiveRunActionProviderId {
  return value === "custom" || isWorkflowConnectorId(value) || isProviderPackId(value);
}
