import { Brain, Check, X } from "lucide-react";
import { useState } from "react";
import type { BotMemory, BotMemoryProposal } from "../contracts";

type Retention = "7" | "30" | "90" | "forever";

function expiryFor(retention: Retention, reviewedAt: string) {
  if (retention === "forever") return undefined;
  const expiresAt = new Date(reviewedAt);
  expiresAt.setUTCDate(expiresAt.getUTCDate() + Number(retention));
  return expiresAt.toISOString();
}

function BotMemoryProposalCard({
  proposal,
  busy,
  onReview,
}: {
  proposal: BotMemoryProposal;
  busy: boolean;
  onReview: (
    proposal: BotMemoryProposal,
    decision: "approve" | "dismiss",
    scope: BotMemory["scope"],
    expiresAt?: string,
  ) => void;
}) {
  const [scope, setScope] = useState<BotMemory["scope"]>("bot");
  const [retention, setRetention] = useState<Retention>("30");

  const review = (decision: "approve" | "dismiss") => {
    const reviewedAt = new Date().toISOString();
    onReview(proposal, decision, scope, expiryFor(retention, reviewedAt));
  };

  return (
    <article className="bot-memory-proposal">
      <span className="bot-initiative-icon"><Brain size={16} /></span>
      <div className="bot-memory-proposal-copy">
        <small>Suggested from this run</small>
        <strong>Remember this?</strong>
        <p>{proposal.body}</p>
        <div className="bot-memory-proposal-options">
          <label>
            <span>Share with</span>
            <select
              aria-label="Memory scope"
              value={scope}
              onChange={(event) => setScope(event.target.value as BotMemory["scope"])}
              disabled={busy}
            >
              <option value="bot">This bot</option>
              <option value="workspace">All bots</option>
            </select>
          </label>
          <label>
            <span>Keep for</span>
            <select
              aria-label="Memory retention"
              value={retention}
              onChange={(event) => setRetention(event.target.value as Retention)}
              disabled={busy}
            >
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="forever">Until I forget</option>
            </select>
          </label>
        </div>
      </div>
      <div className="bot-memory-proposal-actions">
        <button
          type="button"
          className="bot-secondary-action"
          onClick={() => review("dismiss")}
          disabled={busy}
        >
          <X size={14} /> Not now
        </button>
        <button
          type="button"
          className="bot-primary-action"
          onClick={() => review("approve")}
          disabled={busy}
        >
          <Check size={14} /> {busy ? "Saving..." : "Remember"}
        </button>
      </div>
    </article>
  );
}

export default function BotMemoryProposals({
  proposals,
  workingId,
  onReview,
}: {
  proposals: BotMemoryProposal[];
  workingId: string | null;
  onReview: (
    proposal: BotMemoryProposal,
    decision: "approve" | "dismiss",
    scope: BotMemory["scope"],
    expiresAt?: string,
  ) => void;
}) {
  return (
    <section className="bot-memory-proposals" aria-label="Memory suggestions">
      {proposals.map((proposal) => (
        <BotMemoryProposalCard
          key={proposal.id}
          proposal={proposal}
          busy={workingId === proposal.id}
          onReview={onReview}
        />
      ))}
    </section>
  );
}
