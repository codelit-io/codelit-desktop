import {
  Check,
  ChevronRight,
  CircleAlert,
  Cloud,
  ExternalLink,
  GitCompareArrows,
  Link2Off,
  LockKeyhole,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type {
  DesktopCloudCapability,
  DesktopCloudLink,
  DesktopCloudStatus,
  DesktopCloudSyncView,
} from "../contracts";

type CloudWorking = "connecting" | "syncing" | "disconnecting" | null;

const CONFLICT_LABELS: Record<DesktopCloudLink["conflictState"], string> = {
  "in-sync": "In sync",
  "local-changed": "This Mac changed",
  "cloud-changed": "Cloud changed",
  diverged: "Both copies changed",
  attention: "Needs attention",
  "pending-review": "Setup incomplete",
};

function capabilityAction(capability: DesktopCloudCapability, commerce: "direct" | "app-store") {
  if (capability.available) return "Included";
  if (capability.href) return `View ${capability.requiredPlan === "max" ? "Team" : "Pro"}`;
  return commerce === "app-store" ? "Existing plan required" : "Not included";
}

function CloudLinkRow({
  link,
  onOpenHref,
  onReviewLocalCopy,
}: {
  link: DesktopCloudLink;
  onOpenHref: (href: string) => Promise<void>;
  onReviewLocalCopy: (link: DesktopCloudLink) => void;
}) {
  const conflicted = ["local-changed", "cloud-changed", "diverged", "attention"].includes(link.conflictState);
  return (
    <article className="cloud-link-row" data-conflict={link.conflictState}>
      <div className="cloud-link-heading">
        <span className="status-dot" data-status={conflicted ? "quota-hit" : link.cloudState === "active" ? "ready" : "unchecked-auth"} />
        <div>
          <strong>{link.title}</strong>
          <span>{CONFLICT_LABELS[link.conflictState]}</span>
        </div>
      </div>
      {link.latestResult && (
        <p className="cloud-result-summary">
          <Check size={12} /> {link.latestResult.status === "completed" ? "Latest run returned" : "Latest run needs review"}
        </p>
      )}
      <div className="cloud-link-actions">
        {link.reviewHref && (
          <button onClick={() => void onOpenHref(link.reviewHref!)}>
            Finish setup <ExternalLink size={12} />
          </button>
        )}
        {link.projectHref && (
          <button onClick={() => void onOpenHref(link.projectHref!)}>
            Open cloud copy <ExternalLink size={12} />
          </button>
        )}
        {(link.localChanged || link.conflictState === "attention") && (
          <button onClick={() => onReviewLocalCopy(link)}>
            Review this Mac <ChevronRight size={12} />
          </button>
        )}
      </div>
    </article>
  );
}

export default function DesktopCloudSettings({
  status,
  sync,
  links,
  working,
  issue,
  onConnect,
  onDisconnect,
  onSync,
  onOpenHref,
  onReviewLocalCopy,
}: {
  status: DesktopCloudStatus | null;
  sync: DesktopCloudSyncView | null;
  links: DesktopCloudLink[];
  working: CloudWorking;
  issue: string | null;
  onConnect: () => Promise<void>;
  onDisconnect: () => Promise<void>;
  onSync: () => Promise<void>;
  onOpenHref: (href: string) => Promise<void>;
  onReviewLocalCopy: (link: DesktopCloudLink) => void;
}) {
  const connected = status?.status === "connected";
  return (
    <div className="cloud-settings">
      <div className="settings-section-heading">
        <div>
          <h3>Codelit Cloud</h3>
          <p>Optional for 24/7 work, managed browser use, public triggers, and collaboration.</p>
        </div>
        {connected && (
          <button
            className="provider-test icon-label-button"
            disabled={working !== null}
            onClick={() => void onSync()}
          >
            {working === "syncing" ? <span className="spinner" /> : <RefreshCw size={12} />}
            Sync
          </button>
        )}
      </div>

      <div className="cloud-connection" data-status={status?.status || "loading"}>
        <span className="status-dot" data-status={connected ? "ready" : status?.status === "pending" ? "unchecked-auth" : "not-installed"} />
        <div>
          <strong>{connected ? "Connected" : status?.status === "pending" ? "Waiting for approval" : "Local only"}</strong>
          <span>{status?.detail || "Checking optional cloud access..."}</span>
          {status?.pairingCode && <code>{status.pairingCode}</code>}
        </div>
        {!connected && status?.status !== "pending" && (
          <button className="provider-test" disabled={working !== null} onClick={() => void onConnect()}>
            {working === "connecting" ? <span className="spinner" /> : "Connect"}
          </button>
        )}
      </div>

      {issue && (
        <p className="cloud-issue" role="status">
          <CircleAlert size={13} />
          <span>{issue}</span>
        </p>
      )}

      {connected && sync && (
        <>
          <div className="cloud-plan-summary">
            <div>
              <span>Plan</span>
              <strong>{sync.account.planName}</strong>
            </div>
            <div>
              <span>24/7 workflows</span>
              <strong>{sync.account.limits.hostedWorkflows}</strong>
            </div>
            <div>
              <span>Browser minutes</span>
              <strong>{sync.account.limits.managedBrowserMinutes}</strong>
            </div>
          </div>
          <p className="cloud-commerce-note">
            {sync.account.commerce === "app-store"
              ? "Entitlements are read from your Codelit account. This App Store build does not open external checkout."
              : "Hosted upgrades open the Codelit website only when you choose one."}
          </p>

          <div className="cloud-capability-list" aria-label="Hosted capabilities">
            {sync.capabilities.map((capability) => (
              <article key={capability.id} data-available={capability.available}>
                {capability.available ? <Check size={14} /> : <LockKeyhole size={14} />}
                <div>
                  <strong>{capability.title}</strong>
                  <span>{capability.detail}</span>
                </div>
                {capability.href ? (
                  <button onClick={() => void onOpenHref(capability.href!)}>
                    {capabilityAction(capability, sync.account.commerce)} <ExternalLink size={11} />
                  </button>
                ) : (
                  <small>{capabilityAction(capability, sync.account.commerce)}</small>
                )}
              </article>
            ))}
          </div>
        </>
      )}

      {connected && links.length > 0 && (
        <div className="cloud-links">
          <h4><GitCompareArrows size={13} /> Hosted copies</h4>
          {links.map((link) => (
            <CloudLinkRow
              key={link.promotionId}
              link={link}
              onOpenHref={onOpenHref}
              onReviewLocalCopy={onReviewLocalCopy}
            />
          ))}
        </div>
      )}

      {connected && links.length === 0 && (
        <p className="cloud-empty"><Cloud size={14} /> No local workflow has been sent to Codelit Cloud.</p>
      )}

      {connected && (
        <div className="cloud-account-actions">
          <button className="cloud-disconnect" disabled={working !== null} onClick={() => void onDisconnect()}>
            {working === "disconnecting" ? <span className="spinner" /> : <Link2Off size={13} />}
            Disconnect this Mac
          </button>
          <button className="cloud-delete-account" onClick={() => void onOpenHref("/account/delete")}>
            <Trash2 size={13} /> Delete Codelit account &amp; cloud data
          </button>
        </div>
      )}
    </div>
  );
}
