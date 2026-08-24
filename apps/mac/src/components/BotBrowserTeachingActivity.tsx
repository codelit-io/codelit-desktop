import { Check, CircleAlert, FlaskConical, MousePointerClick, Sparkles, TextCursorInput, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LocalBrowserSession,
  LocalBrowserTeachingCapture,
  LocalBrowserTeachingDryRun,
} from "../contracts";
import {
  browserProtectedStepLabel,
  buildTaughtBrowserRecipeDraft,
  type BrowserTeachingRequest,
  type TaughtBrowserRecipeDraft,
} from "../browser-teaching";
import {
  captureLocalBrowserTeaching,
  dryRunLocalBrowserTeaching,
  finishLocalBrowserTeaching,
  startLocalBrowserTeaching,
} from "../runtime";
import LocalBrowserPanel from "./LocalBrowserPanel";

type TeachingPhase = "opening" | "recording" | "review" | "checking" | "ready" | "saving";

function stepLabel(event: LocalBrowserTeachingCapture["events"][number]) {
  const target = event.target?.label || "Protected page control";
  if (event.risk !== "none") return browserProtectedStepLabel(event.risk);
  if (event.type === "fill") return `Enter ${target} at run time`;
  if (event.type === "select") return `Choose ${target} at run time`;
  return `Click ${target}`;
}

export default function BotBrowserTeachingActivity({
  request,
  sessionId,
  botId,
  obscured,
  onSave,
  onCancel,
  onError,
}: {
  request: BrowserTeachingRequest;
  sessionId: string;
  botId: string;
  obscured: boolean;
  onSave: (draft: TaughtBrowserRecipeDraft) => Promise<void>;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const [phase, setPhase] = useState<TeachingPhase>("opening");
  const [name, setName] = useState(request.name);
  const [capture, setCapture] = useState<LocalBrowserTeachingCapture | null>(null);
  const [dryRun, setDryRun] = useState<LocalBrowserTeachingDryRun | null>(null);
  const [message, setMessage] = useState("Opening the private teaching browser...");
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const captureBusy = useRef(false);

  const fail = useCallback((reason: unknown) => {
    const detail = reason instanceof Error ? reason.message : String(reason);
    setError(detail);
    onError(detail);
  }, [onError]);

  const onSessionChange = useCallback((session: LocalBrowserSession | null) => {
    if (!session || session.status !== "ready" || started.current) return;
    started.current = true;
    void startLocalBrowserTeaching(sessionId).then((next) => {
      setCapture(next);
      setPhase("recording");
      setMessage("Do the task once. Codelit records controls and field names, never what you type.");
    }).catch(fail);
  }, [fail, sessionId]);

  useEffect(() => {
    if (phase !== "recording") return;
    const interval = window.setInterval(() => {
      if (captureBusy.current) return;
      captureBusy.current = true;
      void captureLocalBrowserTeaching(sessionId)
        .then(setCapture)
        .catch(() => undefined)
        .finally(() => { captureBusy.current = false; });
    }, 750);
    return () => window.clearInterval(interval);
  }, [phase, sessionId]);

  const review = async () => {
    if (phase !== "recording" || captureBusy.current) return;
    captureBusy.current = true;
    setError(null);
    try {
      const latest = await captureLocalBrowserTeaching(sessionId);
      if (!latest.events.some((event) => event.type !== "navigate")) {
        setMessage("Click or fill one visible control, then review the task.");
        return;
      }
      const finished = await finishLocalBrowserTeaching(sessionId);
      setCapture(finished);
      setDryRun(null);
      setPhase("review");
      setMessage("Review the steps, then check that the visible targets can be replayed safely.");
    } catch (reason) {
      fail(reason);
    } finally {
      captureBusy.current = false;
    }
  };

  const checkReplay = async () => {
    if (phase !== "review") return;
    setPhase("checking");
    setError(null);
    setMessage("Checking every safe target without clicking or typing...");
    try {
      const result = await dryRunLocalBrowserTeaching(sessionId);
      setDryRun(result);
      setPhase(result.passed ? "ready" : "review");
      setMessage(result.passed
        ? "Replay check passed. This skill is ready to save."
        : "One or more targets changed. Demonstrate the task again from a stable page.");
    } catch (reason) {
      setPhase("review");
      fail(reason);
    }
  };

  const save = async () => {
    if (phase !== "ready" || !capture || !dryRun) return;
    setPhase("saving");
    setError(null);
    try {
      await onSave(buildTaughtBrowserRecipeDraft(name, capture, dryRun));
    } catch (reason) {
      setPhase("ready");
      fail(reason);
    }
  };

  const actionCount = capture?.events.filter((event) => event.type !== "navigate").length || 0;
  const protectedCount = capture?.events.filter((event) => event.risk !== "none").length || 0;

  return (
    <article className="bot-browser-teaching" data-phase={phase}>
      <header>
        <span className="bot-teaching-icon"><Sparkles size={14} /></span>
        <div>
          <strong>Teach {name}</strong>
          <span>{message}</span>
        </div>
        <button type="button" className="bots-icon-button" onClick={onCancel} aria-label="Cancel teaching" title="Cancel">
          <X size={14} />
        </button>
      </header>
      <div className="bot-teaching-controls">
        {phase === "recording" && (
          <>
            <span className="bot-recording-status"><i /> Recording · {actionCount} {actionCount === 1 ? "step" : "steps"}</span>
            <button type="button" className="bot-primary-action" onClick={() => void review()}>Review steps</button>
          </>
        )}
        {["review", "checking", "ready", "saving"].includes(phase) && (
          <>
            <label>
              <span>Skill name</span>
              <input value={name} maxLength={64} onChange={(event) => setName(event.target.value)} disabled={["checking", "saving"].includes(phase)} />
            </label>
            <span>{actionCount} steps{protectedCount ? ` · ${protectedCount} takeover` : ""}</span>
            {phase === "review" && <button type="button" className="bot-primary-action" onClick={() => void checkReplay()}><FlaskConical size={13} /> Check replay</button>}
            {phase === "checking" && <span className="bot-teaching-progress">Checking...</span>}
            {phase === "ready" && <button type="button" className="bot-primary-action" onClick={() => void save()}><Check size={13} /> Save skill</button>}
            {phase === "saving" && <span className="bot-teaching-progress">Saving...</span>}
          </>
        )}
      </div>
      {dryRun && (
        <div className="bot-teaching-checks" role="group" aria-label="Browser replay checks">
          {dryRun.checks.map((check) => (
            <span key={check.id} data-passed={check.passed} title={check.detail}>
              {check.passed ? <Check size={12} /> : <CircleAlert size={12} />} {check.label}
            </span>
          ))}
        </div>
      )}
      {error && <div className="bot-teaching-error" role="alert"><CircleAlert size={13} /> {error}</div>}
      <div className="bots-browser-run">
        {phase !== "recording" && capture && (
          <div className="bot-teaching-review" aria-label="Recorded browser steps">
            <header>
              <div>
                <strong>Recorded steps</strong>
                <span>Values stay empty until each run.</span>
              </div>
              <small>{new URL(capture.startUrl).hostname}</small>
            </header>
            <ol>
              {capture.events.filter((event) => event.type !== "navigate").map((event, index) => (
                <li key={`${event.type}-${event.url}-${event.target?.expression || index}`} data-risk={event.risk}>
                  <span>{event.type === "fill" ? <TextCursorInput size={14} /> : <MousePointerClick size={14} />}</span>
                  <div>
                    <strong>{stepLabel(event)}</strong>
                    <small>{event.risk === "none" ? "Allow once when replayed" : "Codelit stops before this step"}</small>
                  </div>
                  <em>{index + 1}</em>
                </li>
              ))}
            </ol>
          </div>
        )}
        <LocalBrowserPanel
          sessionId={sessionId}
          projectId={botId}
          initialUrl={request.url}
          allowedDomains={[request.host]}
          obscured={obscured || phase !== "recording"}
          disabled={phase !== "recording"}
          mode="teach"
          onSessionChange={onSessionChange}
          onOpenError={fail}
          onRequestCloudBrowser={() => undefined}
        />
      </div>
    </article>
  );
}
