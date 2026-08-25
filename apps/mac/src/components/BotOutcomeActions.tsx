import { MessageSquareText, Sparkles } from "lucide-react";
import type { ThreadBlock } from "@/lib/workspace-thread";
import {
  buildBotNextActions,
  buildBotStarterOutcomes,
  latestCompletedBotRequest,
  type BotOutcomeCapabilities,
} from "../bot-outcomes";

interface BotOutcomeActionsProps {
  capabilities: BotOutcomeCapabilities;
  disabled: boolean;
  mode: "starter" | "next";
  onSubmit: (prompt: string) => void;
  blocks?: readonly ThreadBlock[];
}

export default function BotOutcomeActions({
  capabilities,
  disabled,
  mode,
  onSubmit,
  blocks = [],
}: BotOutcomeActionsProps) {
  const actions = mode === "starter"
    ? buildBotStarterOutcomes(capabilities)
    : buildBotNextActions(latestCompletedBotRequest(blocks), capabilities);
  if (!actions.length) return null;
  if (mode === "starter") {
    return (
      <div className="bot-starters" aria-label="Starter tasks">
        {actions.map((action) => (
          <button key={action.id} onClick={() => onSubmit(action.prompt)} disabled={disabled} title={action.prompt}>
            <MessageSquareText size={15} /> <span>{action.label}</span>
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="bot-next-actions" aria-label="Useful next actions">
      <span>Next</span>
      {actions.map((action) => (
        <button key={action.id} onClick={() => onSubmit(action.prompt)} disabled={disabled} title={action.prompt}>
          <Sparkles size={13} /> {action.label}
        </button>
      ))}
    </div>
  );
}
