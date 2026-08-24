import { CheckCircle2, Download, RefreshCw, Store } from "lucide-react";
import { useEffect, useState } from "react";
import type { DesktopUpdateState } from "../contracts";
import { checkDesktopUpdate, installDesktopUpdate, probeDesktopUpdate } from "../runtime";

type UpdateAction = "checking" | "installing" | null;

function channelLabel(channel: DesktopUpdateState["channel"]) {
  if (channel === "app-store") return "Mac App Store";
  if (channel === "direct") return "Codelit Direct";
  return "Development build";
}

export default function DesktopUpdateSettings() {
  const [update, setUpdate] = useState<DesktopUpdateState | null>(null);
  const [action, setAction] = useState<UpdateAction>(null);
  const [issue, setIssue] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void probeDesktopUpdate()
      .then((state) => { if (active) setUpdate(state); })
      .catch((reason: unknown) => {
        if (active) setIssue(reason instanceof Error ? reason.message : String(reason));
      });
    return () => { active = false; };
  }, []);

  const check = async () => {
    setAction("checking");
    setIssue(null);
    try {
      setUpdate(await checkDesktopUpdate());
    } catch (reason) {
      setIssue(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAction(null);
    }
  };

  const install = async () => {
    setAction("installing");
    setIssue(null);
    try {
      await installDesktopUpdate();
    } catch (reason) {
      setIssue(reason instanceof Error ? reason.message : String(reason));
      setAction(null);
    }
  };

  const direct = update?.channel === "direct";
  const available = update?.status === "available";
  return (
    <div className="desktop-update-settings">
      <div className="settings-section-heading">
        <div>
          <h3>Codelit updates</h3>
          <p>Updates are verified by the channel that installed this app.</p>
        </div>
      </div>
      <div className="storage-detail storage-row desktop-update-row">
        {update?.channel === "app-store"
          ? <Store size={16} />
          : update?.status === "current"
            ? <CheckCircle2 size={16} />
            : <RefreshCw size={16} />}
        <div>
          <strong>{update ? channelLabel(update.channel) : "Checking release channel"}</strong>
          <span>{update?.detail || "Reading this app's update policy..."}</span>
        </div>
        {direct && (
          <button
            className="provider-test icon-label-button"
            disabled={action !== null}
            onClick={() => void (available ? install() : check())}
          >
            {action ? <span className="spinner" /> : available ? <Download size={12} /> : <RefreshCw size={12} />}
            {action === "checking"
              ? "Checking"
              : action === "installing"
                ? "Installing"
                : available
                  ? "Install and relaunch"
                  : "Check"}
          </button>
        )}
      </div>
      {available && update.availableVersion && (
        <p className="desktop-update-version">
          Version {update.availableVersion}
          {update.notes ? `: ${update.notes}` : " is ready."}
        </p>
      )}
      {issue && <p className="cloud-issue" role="status">{issue}</p>}
    </div>
  );
}
