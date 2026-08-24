import {
  CalendarClock,
  Check,
  ChevronRight,
  Cloud,
  ExternalLink,
  LockKeyhole,
  Monitor,
  Pause,
  Play,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DesktopHostedPromotionEnvelope,
  DesktopPromotionArtifact,
  DesktopPromotionReviewItem,
} from "@/lib/local-desktop-hosted-promotion";
import type {
  BackgroundServiceProbe,
  DesktopCloudLink,
  DesktopCloudCapabilityId,
  DesktopCloudTransferIntent,
  DesktopCloudStatus,
  DesktopCloudSyncView,
  IntelligenceSelection,
  LocalArtifactVersion,
  LocalSchedule,
  LocalScheduleCadence,
  LocalScheduleMissedPolicy,
  SaveLocalScheduleRequest,
} from "../contracts";
import { publishDesktopHostedPromotion, startDesktopCloudPairing } from "../runtime";

const WEEKDAYS = [
  { value: 1, label: "M" },
  { value: 2, label: "T" },
  { value: 3, label: "W" },
  { value: 4, label: "T" },
  { value: 5, label: "F" },
  { value: 6, label: "S" },
  { value: 7, label: "S" },
] as const;

const HOSTED_INTENT_COPY: Record<DesktopCloudCapabilityId, { title: string; detail: string }> = {
  "run-24-7": {
    title: "Keep this Team running",
    detail: "Choose a saved schedule below, then review the exact copy that will run when this Mac is offline.",
  },
  "cloud-browser": {
    title: "Prepare a cloud browser",
    detail: "Move a reviewed Team copy first. Local cookies stay on this Mac and cloud browser access is configured separately.",
  },
  "public-trigger": {
    title: "Add a public trigger",
    detail: "Move a reviewed Team copy first, then choose the webhook or remote event in Codelit Cloud.",
  },
  collaboration: {
    title: "Share a reviewed copy",
    detail: "Move a reviewed artifact first. Your local files, provider sessions, and credentials remain on this Mac.",
  },
};

const SYNC_INTENT_COPY = {
  title: "Review a new cloud copy",
  detail: "Create a sanitized copy of this exact local version without moving local files or provider access.",
};

function defaultOnceTime() {
  const value = new Date();
  value.setDate(value.getDate() + 1);
  value.setHours(9, 0, 0, 0);
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

function describeNextRun(schedule: LocalSchedule) {
  if (!schedule.enabled) return "Paused";
  if (schedule.pausedReason) return schedule.pausedReason;
  if (!schedule.nextDueAt) return "No future run";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(schedule.nextDueAt));
}

function describeHostedAction(link: DesktopCloudLink | undefined, artifactKind: LocalArtifactVersion["kind"]) {
  if (!link) return artifactKind === "agent-team" ? "Run 24/7" : "Sync to cloud";
  if (link.localChanged || link.conflictState === "diverged" || link.status === "cancelled") return "Review new copy";
  if (link.reviewHref) return "Finish hosted setup";
  if (link.cloudState === "active") return "Hosted active";
  if (link.cloudState === "attention") return "Needs attention";
  if (link.projectHref) return "Open cloud copy";
  return "Check hosted copy";
}

function promotionArtifact(schedule: LocalSchedule, threadId: string): DesktopPromotionArtifact {
  const snapshot = schedule.snapshot && typeof schedule.snapshot === "object" && !Array.isArray(schedule.snapshot)
    ? schedule.snapshot as Record<string, unknown>
    : null;
  const kind = snapshot?.artifactKind;
  if (kind !== "agent-team" && kind !== "product-plan" && kind !== "architecture") {
    throw new Error("This saved schedule does not contain a promotable artifact snapshot.");
  }
  if (!snapshot || typeof snapshot.artifactTitle !== "string" || !("artifactPayload" in snapshot)) {
    throw new Error("This saved schedule is incomplete. Save it again before continuing.");
  }
  return {
    threadId,
    artifactId: schedule.artifactId,
    version: schedule.artifactVersion,
    kind,
    title: snapshot.artifactTitle,
    payload: snapshot.artifactPayload,
  };
}

function ReviewList({ title, icon: Icon, items }: {
  title: string;
  icon: typeof Cloud;
  items: DesktopPromotionReviewItem[];
}) {
  if (!items.length) return null;
  return (
    <div className="promotion-review-group">
      <h4><Icon size={13} /> {title}</h4>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <strong>{item.label}</strong>
            <span>{item.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function LocalSchedulePanel({
  artifact,
  threadId,
  engine,
  schedules,
  backgroundService,
  cloudStatus,
  cloudSync,
  cloudLinks,
  initialReviewScheduleId,
  hostedCapabilityIntent,
  onClose,
  onSave,
  onToggle,
  onDelete,
  onSetBackground,
  onOpenSystemSettings,
  onCloudStatusChange,
  onPromotionOpened,
  onOpenCloudHref,
}: {
  artifact: LocalArtifactVersion;
  threadId: string;
  engine: IntelligenceSelection | null;
  schedules: LocalSchedule[];
  backgroundService: BackgroundServiceProbe | null;
  cloudStatus: DesktopCloudStatus | null;
  cloudSync: DesktopCloudSyncView | null;
  cloudLinks: DesktopCloudLink[];
  initialReviewScheduleId: string | null;
  hostedCapabilityIntent: DesktopCloudTransferIntent | null;
  onClose: () => void;
  onSave: (request: SaveLocalScheduleRequest) => Promise<void>;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onSetBackground: (enabled: boolean) => Promise<BackgroundServiceProbe>;
  onOpenSystemSettings: () => Promise<void>;
  onCloudStatusChange: (status: DesktopCloudStatus) => void;
  onPromotionOpened: () => Promise<void>;
  onOpenCloudHref: (href: string) => Promise<void>;
}) {
  const artifactSchedules = useMemo(
    () => schedules.filter((schedule) => schedule.artifactId === artifact.artifactId),
    [artifact.artifactId, schedules],
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState(`${artifact.title} schedule`);
  const [cadence, setCadence] = useState<LocalScheduleCadence>("weekdays");
  const [localTime, setLocalTime] = useState("09:00");
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [onceAt, setOnceAt] = useState(defaultOnceTime);
  const [missedPolicy, setMissedPolicy] = useState<LocalScheduleMissedPolicy>("run-once");
  const [maxRetries, setMaxRetries] = useState(2);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [promotion, setPromotion] = useState<{
    schedule: LocalSchedule | null;
    envelope: DesktopHostedPromotionEnvelope;
  } | null>(null);
  const [promotionOpened, setPromotionOpened] = useState(false);
  const automaticReview = useRef<string | null>(null);
  const automaticIntentReview = useRef<string | null>(null);
  const capabilityId = hostedCapabilityIntent && hostedCapabilityIntent !== "sync"
    ? hostedCapabilityIntent
    : promotion?.envelope.mode === "run-24-7"
      ? "run-24-7"
      : null;
  const hostedCapability = capabilityId
    ? cloudSync?.capabilities.find((capability) => capability.id === capabilityId)
    : undefined;
  const hostedIntentCopy = hostedCapabilityIntent === "sync"
    ? SYNC_INTENT_COPY
    : hostedCapabilityIntent
      ? HOSTED_INTENT_COPY[hostedCapabilityIntent]
      : null;
  const linkBySchedule = useMemo(() => {
    const links = new Map<string, DesktopCloudLink>();
    for (const link of cloudLinks) {
      if (link.scheduleId && !links.has(link.scheduleId)) links.set(link.scheduleId, link);
    }
    return links;
  }, [cloudLinks]);

  useEffect(() => {
    setEditingId(null);
    setTitle(`${artifact.title} schedule`);
    setPromotion(null);
    automaticIntentReview.current = null;
  }, [artifact.artifactId, artifact.title, artifact.version]);

  const resetDraft = () => {
    setEditingId(null);
    setTitle(`${artifact.title} schedule`);
    setCadence("weekdays");
    setLocalTime("09:00");
    setWeekdays([1, 2, 3, 4, 5]);
    setOnceAt(defaultOnceTime());
    setMissedPolicy("run-once");
    setMaxRetries(2);
    setError(null);
  };

  const editSchedule = (schedule: LocalSchedule) => {
    setEditingId(schedule.id);
    setTitle(schedule.title);
    setCadence(schedule.cadence);
    setLocalTime(schedule.localTime);
    setWeekdays(schedule.weekdays);
    setMissedPolicy(schedule.missedPolicy);
    setMaxRetries(schedule.maxRetries);
    if (schedule.oneTimeAt) {
      const date = new Date(schedule.oneTimeAt);
      const offset = date.getTimezoneOffset() * 60_000;
      setOnceAt(new Date(date.getTime() - offset).toISOString().slice(0, 16));
    }
    setError(null);
  };

  const save = async () => {
    if (!engine) {
      setError("Choose a ready model before scheduling this workflow.");
      return;
    }
    if (!title.trim()) {
      setError("Name this schedule so you can recognize it later.");
      return;
    }
    if (cadence === "weekly" && weekdays.length === 0) {
      setError("Choose at least one day.");
      return;
    }
    setWorking("save");
    setError(null);
    try {
      let service = backgroundService;
      if (service?.status !== "enabled") {
        service = await onSetBackground(true);
      }
      const oneTimeAt = cadence === "once" ? new Date(onceAt).toISOString() : undefined;
      await onSave({
        id: editingId || `schedule-${crypto.randomUUID()}`,
        threadId,
        artifactId: artifact.artifactId,
        artifactVersion: artifact.version,
        title: title.trim(),
        enabled: true,
        cadence,
        localTime,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        weekdays: cadence === "weekdays" ? [1, 2, 3, 4, 5] : weekdays,
        missedPolicy,
        maxRetries,
        provider: engine.provider,
        model: engine.model,
        requiresNetwork: !["mlx", "ollama"].includes(engine.provider),
        snapshot: {
          artifactKind: artifact.kind,
          artifactTitle: artifact.title,
          artifactPayload: artifact.payload,
        },
        oneTimeAt,
      });
      resetDraft();
      if (service?.status === "requires-approval") {
        setError("Approve Codelit in macOS Login Items so this schedule can run while the app is closed.");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(null);
    }
  };

  const runAction = async (key: string, action: () => Promise<void>) => {
    setWorking(key);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(null);
    }
  };

  const reviewHostedPromotion = useCallback(async (schedule: LocalSchedule) => {
    setWorking(`review-${schedule.id}`);
    setError(null);
    setPromotionOpened(false);
    try {
      let sourceSchedule = schedule;
      if (schedule.artifactVersion !== artifact.version) {
        const currentSnapshot = {
          artifactKind: artifact.kind,
          artifactTitle: artifact.title,
          artifactPayload: artifact.payload,
        };
        await onSave({
          id: schedule.id,
          threadId,
          artifactId: artifact.artifactId,
          artifactVersion: artifact.version,
          title: schedule.title,
          enabled: schedule.enabled,
          cadence: schedule.cadence,
          localTime: schedule.localTime,
          timezone: schedule.timezone,
          weekdays: schedule.weekdays,
          missedPolicy: schedule.missedPolicy,
          maxRetries: schedule.maxRetries,
          provider: schedule.provider,
          model: schedule.model,
          requiresNetwork: schedule.requiresNetwork,
          snapshot: currentSnapshot,
          oneTimeAt: schedule.oneTimeAt,
        });
        sourceSchedule = {
          ...schedule,
          artifactVersion: artifact.version,
          snapshot: currentSnapshot,
        };
      }
      const { createDesktopHostedPromotion } = await import("@/lib/local-desktop-hosted-promotion");
      const envelope = createDesktopHostedPromotion({
        artifact: promotionArtifact(sourceSchedule, threadId),
        schedule: {
          id: sourceSchedule.id,
          title: sourceSchedule.title,
          cadence: sourceSchedule.cadence,
          localTime: sourceSchedule.localTime,
          timezone: sourceSchedule.timezone,
          weekdays: sourceSchedule.weekdays,
          missedPolicy: sourceSchedule.missedPolicy,
          maxRetries: sourceSchedule.maxRetries,
        },
      });
      setPromotion({ schedule: sourceSchedule, envelope });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(null);
    }
  }, [artifact, onSave, threadId]);

  const reviewArtifactPromotion = useCallback(async (intent: Exclude<DesktopCloudTransferIntent, "run-24-7">) => {
    setWorking("review-artifact");
    setError(null);
    setPromotionOpened(false);
    try {
      if (artifact.kind !== "agent-team" && artifact.kind !== "product-plan" && artifact.kind !== "architecture") {
        throw new Error("This artifact cannot be moved to Codelit Cloud.");
      }
      const { createDesktopHostedPromotion } = await import("@/lib/local-desktop-hosted-promotion");
      const envelope = createDesktopHostedPromotion({
        artifact: {
          threadId,
          artifactId: artifact.artifactId,
          version: artifact.version,
          kind: artifact.kind,
          title: artifact.title,
          payload: artifact.payload,
        },
        intent,
      });
      setPromotion({ schedule: null, envelope });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(null);
    }
  }, [artifact, threadId]);

  useEffect(() => {
    if (!initialReviewScheduleId || automaticReview.current === initialReviewScheduleId) return;
    const schedule = artifactSchedules.find((candidate) => candidate.id === initialReviewScheduleId);
    if (!schedule) return;
    automaticReview.current = initialReviewScheduleId;
    void reviewHostedPromotion(schedule);
  }, [artifactSchedules, initialReviewScheduleId, reviewHostedPromotion]);

  useEffect(() => {
    if (!hostedCapabilityIntent || hostedCapabilityIntent === "run-24-7" || initialReviewScheduleId) return;
    const key = `${artifact.artifactId}:${artifact.version}:${hostedCapabilityIntent}`;
    if (automaticIntentReview.current === key) return;
    automaticIntentReview.current = key;
    void reviewArtifactPromotion(hostedCapabilityIntent);
  }, [artifact.artifactId, artifact.version, hostedCapabilityIntent, initialReviewScheduleId, reviewArtifactPromotion]);

  const continueHostedPromotion = async () => {
    if (!promotion) return;
    setError(null);
    if (cloudStatus?.status !== "connected") {
      setWorking("pairing");
      try {
        onCloudStatusChange(await startDesktopCloudPairing());
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setWorking(null);
      }
      return;
    }
    setWorking("promotion");
    try {
      await publishDesktopHostedPromotion(promotion.envelope);
      setPromotionOpened(true);
      await onPromotionOpened();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(null);
    }
  };

  return (
    <aside className="schedule-panel" aria-label={`Schedule ${artifact.title}`}>
      <header>
        <div>
          <span className="eyebrow">This Mac</span>
              <h2>{hostedCapabilityIntent && hostedCapabilityIntent !== "run-24-7" ? "Cloud transfer" : "Schedule workflow"}</h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close schedule panel">
          <X size={18} />
        </button>
      </header>

      <div className="schedule-panel-scroll">
        <section className="schedule-context">
          {hostedCapabilityIntent && hostedCapabilityIntent !== "run-24-7"
            ? <Cloud size={18} />
            : <CalendarClock size={18} />}
          <div>
            <strong>{artifact.title}</strong>
            <span>{hostedCapabilityIntent && hostedCapabilityIntent !== "run-24-7"
              ? `Version ${artifact.version} is the only copy included in this review.`
              : `Version ${artifact.version} will be pinned to this schedule.`}</span>
          </div>
        </section>

        {hostedIntentCopy && !promotion && working !== "review-artifact" && (
          <section className="hosted-intent" aria-label={hostedIntentCopy.title}>
            <Cloud size={18} />
            <div>
              <strong>{hostedIntentCopy.title}</strong>
              <span>{hostedIntentCopy.detail}</span>
              <small>Nothing uploads before the transfer review.</small>
            </div>
          </section>
        )}

        {working === "review-artifact" && (
          <section className="hosted-intent-loading" role="status">
            <span className="spinner" /> Preparing a private transfer review
          </section>
        )}

        {promotion && (
          <section className="promotion-review" aria-label="Hosted transfer review">
            <div className="promotion-review-heading">
              <div>
                <span className="eyebrow">Review first</span>
                <h3>{promotion.envelope.mode === "run-24-7"
                  ? "Run 24/7"
                  : hostedIntentCopy?.title || "Sync to Codelit Cloud"}</h3>
              </div>
              <button
                className="icon-button"
                onClick={() => {
                  setPromotion(null);
                  setPromotionOpened(false);
                  setError(null);
                }}
                aria-label="Close hosted review"
              >
                <X size={15} />
              </button>
            </div>
            <p className="promotion-intro">
              Nothing uploads until you continue. Provider sign-ins and secrets are added separately in the browser.
            </p>
            <ReviewList title="Moves to Codelit Cloud" icon={Cloud} items={promotion.envelope.review.transfers} />
            <ReviewList title="Stays on this Mac" icon={Monitor} items={promotion.envelope.review.staysOnMac} />
            <ReviewList title="Needs cloud setup" icon={LockKeyhole} items={promotion.envelope.review.needsCloudSetup} />
            <ReviewList title="Schedule differences" icon={CalendarClock} items={promotion.envelope.review.scheduleChanges} />
            {hostedCapability && (
              <div className="promotion-entitlement" data-available={hostedCapability.available}>
                {hostedCapability.available ? <Check size={14} /> : <LockKeyhole size={14} />}
                <div>
                  <strong>{hostedCapability.available
                    ? `${hostedCapability.title} is included`
                    : `${hostedCapability.requiredPlan === "max" ? "Team" : "Pro"} required`}</strong>
                  <span>{hostedCapability.detail}</span>
                </div>
                {hostedCapability.href && (
                  <button onClick={() => void onOpenCloudHref(hostedCapability.href!)}>
                    View plan <ExternalLink size={12} />
                  </button>
                )}
              </div>
            )}
            <div className="promotion-cloud-state" data-status={cloudStatus?.status || "loading"}>
              {cloudStatus?.status === "connected" ? <Check size={14} /> : <ShieldCheck size={14} />}
              <span>{cloudStatus?.detail || "Checking the optional cloud connection..."}</span>
            </div>
            {error && <p className="schedule-error" role="alert">{error}</p>}
            {promotionOpened ? (
              <div className="promotion-opened" role="status">
                <Check size={15} />
              <span>The final setup is open in your browser. This local work is unchanged.</span>
              </div>
            ) : (
              <button
                className="promotion-continue"
                disabled={
                  working !== null
                  || cloudStatus?.status === "pending"
                  || !cloudStatus
                  || Boolean(hostedCapability && !hostedCapability.available && !hostedCapability.href)
                }
                onClick={() => void continueHostedPromotion()}
              >
                {working === "pairing" || working === "promotion" ? <span className="spinner dark" /> : <Cloud size={15} />}
                {hostedCapability && !hostedCapability.available && !hostedCapability.href
                  ? "Existing hosted plan required"
                  : cloudStatus?.status === "connected"
                    ? "Continue to final setup"
                    : cloudStatus?.status === "pending"
                    ? "Waiting for browser approval"
                    : "Connect Codelit Cloud"}
              </button>
            )}
          </section>
        )}

        {!promotion && working !== "review-artifact" && (!hostedCapabilityIntent || hostedCapabilityIntent === "run-24-7") && <section className="schedule-form">
          <label>
            Name
            <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} />
          </label>
          <div className="schedule-form-grid">
            <label>
              Repeats
              <select value={cadence} onChange={(event) => setCadence(event.target.value as LocalScheduleCadence)}>
                <option value="weekdays">Weekdays</option>
                <option value="daily">Every day</option>
                <option value="weekly">Selected days</option>
                <option value="once">Once</option>
              </select>
            </label>
            {cadence === "once" ? (
              <label>
                Runs at
                <input type="datetime-local" value={onceAt} onChange={(event) => setOnceAt(event.target.value)} />
              </label>
            ) : (
              <label>
                Time
                <input type="time" value={localTime} onChange={(event) => setLocalTime(event.target.value)} />
              </label>
            )}
          </div>
          {cadence === "weekly" && (
            <fieldset className="weekday-picker">
              <legend>Days</legend>
              <div>
                {WEEKDAYS.map((day) => (
                  <button
                    key={day.value}
                    type="button"
                    aria-pressed={weekdays.includes(day.value)}
                    onClick={() => setWeekdays((current) => (
                      current.includes(day.value)
                        ? current.filter((value) => value !== day.value)
                        : [...current, day.value].sort()
                    ))}
                  >
                    {day.label}
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          <div className="schedule-form-grid">
            <label>
              If this Mac misses a run
              <select value={missedPolicy} onChange={(event) => setMissedPolicy(event.target.value as LocalScheduleMissedPolicy)}>
                <option value="run-once">Run once after wake</option>
                <option value="skip">Skip it</option>
                <option value="run-every">Run every missed time</option>
              </select>
            </label>
            <label>
              Retry limit
              <select value={maxRetries} onChange={(event) => setMaxRetries(Number(event.target.value))}>
                {[0, 1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
          </div>
          <div className="schedule-engine">
            <span>Runs with</span>
            <strong>{engine ? `${engine.provider} / ${engine.model}` : "Choose a model first"}</strong>
          </div>
          <p className="schedule-boundary">
            Runs locally while this Mac is awake, online when needed, and signed in to the selected provider.
          </p>
          {error && <p className="schedule-error" role="alert">{error}</p>}
          {backgroundService?.status === "requires-approval" && (
            <button className="system-settings-button" onClick={() => void onOpenSystemSettings()}>
              Review Login Items <ExternalLink size={14} />
            </button>
          )}
          <div className="schedule-form-actions">
            {editingId && <button onClick={resetDraft}>Cancel edit</button>}
            <button className="primary-action" disabled={working !== null || !engine} onClick={() => void save()}>
              {working === "save" ? <span className="spinner dark" /> : <CalendarClock size={15} />}
              {editingId ? "Update schedule" : backgroundService?.status === "enabled" ? "Save schedule" : "Enable and schedule"}
            </button>
          </div>
        </section>}

        {!promotion && working !== "review-artifact" && artifactSchedules.length > 0 && (!hostedCapabilityIntent || hostedCapabilityIntent === "run-24-7") && (
          <section className="saved-schedules">
            <h3>Saved schedules</h3>
            {artifactSchedules.map((schedule) => {
              const cloudLink = linkBySchedule.get(schedule.id);
              const openExisting = cloudLink?.reviewHref || cloudLink?.projectHref;
              const reviewNew = Boolean(
                cloudLink?.localChanged
                || cloudLink?.conflictState === "diverged"
                || cloudLink?.status === "cancelled",
              );
              const actionLabel = describeHostedAction(cloudLink, artifact.kind);
              return (
              <article key={schedule.id}>
                <div className="saved-schedule-main">
                  <button className="schedule-summary" onClick={() => editSchedule(schedule)}>
                    <span className="status-dot" data-status={schedule.enabled ? "enabled" : "not-registered"} />
                    <span>
                      <strong>{schedule.title}</strong>
                      <small>{describeNextRun(schedule)}</small>
                      {cloudLink && <small className="schedule-cloud-status">{actionLabel}</small>}
                    </span>
                    <ChevronRight size={15} />
                  </button>
                  <div className="schedule-row-actions">
                    <button
                      aria-label={schedule.enabled ? `Pause ${schedule.title}` : `Resume ${schedule.title}`}
                      title={schedule.enabled ? "Pause" : "Resume"}
                      disabled={working !== null}
                      onClick={() => void runAction(`toggle-${schedule.id}`, () => onToggle(schedule.id, !schedule.enabled))}
                    >
                      {working === `toggle-${schedule.id}` ? <span className="spinner" /> : schedule.enabled ? <Pause size={14} /> : <Play size={14} />}
                    </button>
                    <button
                      className="danger-icon"
                      aria-label={`Delete ${schedule.title}`}
                      title="Delete schedule"
                      disabled={working !== null}
                      onClick={() => void runAction(`delete-${schedule.id}`, () => onDelete(schedule.id))}
                    >
                      {working === `delete-${schedule.id}` ? <span className="spinner" /> : <Trash2 size={14} />}
                    </button>
                  </div>
                </div>
                <button
                  className="schedule-promote"
                  disabled={working !== null}
                  onClick={() => {
                    if (!reviewNew && openExisting) void onOpenCloudHref(openExisting);
                    else void reviewHostedPromotion(schedule);
                  }}
                >
                  {working === `review-${schedule.id}` ? <span className="spinner" /> : <Cloud size={14} />}
                  {actionLabel}
                  <ChevronRight size={14} />
                </button>
              </article>
              );
            })}
          </section>
        )}
      </div>
    </aside>
  );
}
