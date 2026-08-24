import {
  Check,
  CircleAlert,
  Hand,
  MousePointerClick,
  Play,
  ShieldCheck,
  TextCursorInput,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BotSkill,
  LocalBrowserProof,
  LocalBrowserSession,
  LocalToolBatchResult,
  ProviderRunEvent,
} from "../contracts";
import {
  browserProtectedStepLabel,
  browserReplayToolInputs,
  type TaughtBrowserRecipe,
  type TaughtBrowserRecipeStep,
} from "../browser-teaching";
import {
  cancelIntelligenceTask,
  discardPreparedLocalToolApproval,
  prepareNativeToolApproval,
  runApprovedLocalBrowserAction,
} from "../runtime";
import LocalBrowserPanel from "./LocalBrowserPanel";

type ReplayPhase = "inputs" | "queued" | "opening" | "preparing" | "awaiting" | "running" | "takeover";

export interface BrowserSkillReplayOutcome {
  status: "completed" | "failed" | "canceled";
  summary: string;
  events: ProviderRunEvent[];
  proofs: LocalBrowserProof[];
  completedTools: LocalToolBatchResult["completedTools"];
  completedStepIds: string[];
  automatedSteps: number;
  takeoverSteps: number;
  durationMs: number;
}

interface BrowserSkillApprovalUpdate {
  id: string;
  stepIndex: number;
  status: "awaiting" | "approved" | "held";
  body: unknown;
}

interface BrowserSkillCheckpoint {
  stepIndex: number;
  handoff: string;
  priorSteps: unknown[];
  gateApproved: boolean;
  runContext: unknown;
}

function stepLabel(step: TaughtBrowserRecipeStep, recipe: TaughtBrowserRecipe) {
  if (step.risk !== "none") return browserProtectedStepLabel(step.risk);
  if (step.type === "fill") {
    return `Enter ${recipe.inputs.find((input) => input.id === step.inputId)?.label || step.target?.label || "value"}`;
  }
  return `Click ${step.target?.label || "page control"}`;
}

function replayEvent(event: ProviderRunEvent, sequence: number): ProviderRunEvent {
  return {
    ...event,
    sequence,
    provider: "codelit",
    model: "browser-replay-v1",
  };
}

function redactedPreviewDetail(
  step: TaughtBrowserRecipeStep,
  evidence: string[],
) {
  const typed = evidence
    .flatMap((entry) => entry.split("\n"))
    .find((line) => line.startsWith("Typed value:"));
  return `${new URL(step.url).hostname} · ${typed || "Visible target rechecked immediately before the action"}`;
}

export default function BotBrowserSkillRunActivity({
  skill,
  recipe,
  runId,
  sessionId,
  botId,
  obscured,
  onAcquireBrowser,
  onApproval,
  onCheckpoint,
  onFinish,
  onError,
}: {
  skill: BotSkill;
  recipe: TaughtBrowserRecipe;
  runId: string;
  sessionId: string;
  botId: string;
  obscured: boolean;
  onAcquireBrowser: () => Promise<void>;
  onApproval: (update: BrowserSkillApprovalUpdate) => Promise<void>;
  onCheckpoint: (checkpoint: BrowserSkillCheckpoint) => Promise<void>;
  onFinish: (outcome: BrowserSkillReplayOutcome) => Promise<void>;
  onError: (message: string) => void;
}) {
  const steps = useMemo(() => recipe.steps.filter((step) => step.type !== "navigate"), [recipe.steps]);
  const [phase, setPhase] = useState<ReplayPhase>(recipe.inputs.length ? "inputs" : "queued");
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(
    recipe.inputs.map((input) => [input.id, ""]),
  ));
  const [activeIndex, setActiveIndex] = useState(0);
  const [preview, setPreview] = useState<{ summary: string; evidence: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const valuesRef = useRef(values);
  const ready = useRef(false);
  const begun = useRef(false);
  const starting = useRef(false);
  const finished = useRef(false);
  const preparing = useRef(false);
  const prepareAbort = useRef<AbortController | null>(null);
  const currentApproval = useRef<{ id: string; body: unknown; sha256?: string } | null>(null);
  const toolInputs = useRef<Record<string, Record<string, unknown>> | null>(null);
  const events = useRef<ProviderRunEvent[]>([]);
  const proofs = useRef<LocalBrowserProof[]>([]);
  const completedTools = useRef<LocalToolBatchResult["completedTools"]>([]);
  const completedStepIds = useRef<string[]>([]);
  const automatedSteps = useRef(0);
  const takeoverSteps = useRef(0);
  const startedAt = useRef(performance.now());
  const currentStep = steps[activeIndex] || null;

  useEffect(() => { valuesRef.current = values; }, [values]);

  const finish = useCallback(async (
    status: BrowserSkillReplayOutcome["status"],
    summary: string,
  ) => {
    if (finished.current) return;
    finished.current = true;
    prepareAbort.current?.abort();
    currentApproval.current = null;
    toolInputs.current = null;
    valuesRef.current = {};
    setValues({});
    await discardPreparedLocalToolApproval(runId).catch(() => undefined);
    await onFinish({
      status,
      summary,
      events: events.current,
      proofs: proofs.current,
      completedTools: completedTools.current,
      completedStepIds: completedStepIds.current,
      automatedSteps: automatedSteps.current,
      takeoverSteps: takeoverSteps.current,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt.current)),
    });
  }, [onFinish, runId]);

  const fail = useCallback(async (reason: unknown) => {
    const detail = reason instanceof Error ? reason.message : String(reason);
    setError(detail);
    onError(detail);
    await finish("failed", detail);
  }, [finish, onError]);

  const recordEvent = useCallback((event: ProviderRunEvent) => {
    events.current.push(replayEvent(event, events.current.length + 1));
  }, []);

  const approvalBody = useCallback((step: TaughtBrowserRecipeStep, approvalSha256?: string, evidence?: string[]) => ({
    kind: "browser-skill-replay",
    skill: {
      id: skill.id,
      version: skill.version,
      checksum: skill.checksum,
    },
    step: {
      id: step.id,
      type: step.type,
      label: stepLabel(step, recipe),
      host: new URL(step.url).hostname,
      risk: step.risk,
    },
    ...(approvalSha256 ? { approvalSha256 } : {}),
    ...(evidence ? { evidence } : {}),
  }), [recipe, skill.checksum, skill.id, skill.version]);

  const prepareStep = useCallback(async (index: number) => {
    if (finished.current || preparing.current) return;
    const step = steps[index];
    if (!step) {
      await finish(
        "completed",
        `${skill.name} finished ${completedStepIds.current.length} reviewed ${completedStepIds.current.length === 1 ? "step" : "steps"}.`,
      );
      return;
    }
    preparing.current = true;
    setActiveIndex(index);
    setPreview(null);
    setError(null);
    try {
      const id = `${runId}-${step.id}`;
      if (step.risk !== "none" || !["click", "fill"].includes(step.type)) {
        const body = approvalBody(step);
        currentApproval.current = { id, body };
        await onApproval({ id, stepIndex: index, status: "awaiting", body });
        setPhase("takeover");
        return;
      }
      const inputs = browserReplayToolInputs(skill, recipe, step, valuesRef.current);
      toolInputs.current = inputs;
      setPhase("preparing");
      const controller = new AbortController();
      prepareAbort.current = controller;
      const approval = await prepareNativeToolApproval(
        runId,
        ["Browser act"],
        `Browser skill ${skill.id} v${skill.version}, ${step.id}`,
        inputs,
        recordEvent,
        controller.signal,
        { sessionId, projectId: botId },
      );
      if (!approval.approvalSha256) throw new Error("The exact browser action could not be bound for approval.");
      const body = approvalBody(step, approval.approvalSha256, approval.evidence);
      currentApproval.current = { id, body, sha256: approval.approvalSha256 };
      await onApproval({ id, stepIndex: index, status: "awaiting", body });
      setPreview({ summary: approval.summary, evidence: approval.evidence });
      setPhase("awaiting");
    } catch (reason) {
      if (finished.current) return;
      await fail(reason);
    } finally {
      prepareAbort.current = null;
      preparing.current = false;
    }
  }, [approvalBody, botId, fail, finish, onApproval, recipe, recordEvent, runId, sessionId, skill, steps]);

  const begin = useCallback(async () => {
    if (starting.current || finished.current) return;
    starting.current = true;
    setError(null);
    try {
      for (const step of steps) {
        if (step.type === "fill" && step.risk === "none") {
          browserReplayToolInputs(skill, recipe, step, valuesRef.current);
        }
      }
      await onAcquireBrowser();
      begun.current = true;
      setPhase("opening");
    } catch (reason) {
      starting.current = false;
      if (finished.current) return;
      const detail = reason instanceof Error ? reason.message : String(reason);
      setError(detail);
      onError(detail);
      return;
    }
    starting.current = false;
  }, [onAcquireBrowser, onError, recipe, skill, steps]);

  useEffect(() => {
    if (!recipe.inputs.length && !begun.current) void begin();
  }, [begin, recipe.inputs.length]);

  const onSessionChange = useCallback((session: LocalBrowserSession | null) => {
    if (!session || session.status !== "ready" || ready.current || finished.current) return;
    ready.current = true;
    void prepareStep(0);
  }, [prepareStep]);

  const hold = async () => {
    prepareAbort.current?.abort();
    if (["preparing", "running"].includes(phase)) {
      await cancelIntelligenceTask(runId).catch(() => undefined);
    }
    const approval = currentApproval.current;
    if (approval) {
      try {
        await onApproval({ id: approval.id, stepIndex: activeIndex, status: "held", body: approval.body });
      } catch (reason) {
        onError(reason instanceof Error ? reason.message : String(reason));
      }
    }
    await finish("canceled", `${skill.name} stopped before ${currentStep ? stepLabel(currentStep, recipe) : "the next step"}.`);
  };

  const allowOnce = async () => {
    const step = currentStep;
    const approval = currentApproval.current;
    const inputs = toolInputs.current;
    if (!step || !approval?.sha256 || !inputs || phase !== "awaiting") return;
    setPhase("running");
    setError(null);
    try {
      await onApproval({ id: approval.id, stepIndex: activeIndex, status: "approved", body: {
        ...(approval.body as Record<string, unknown>),
        decisionSource: "user",
      } });
      const result = await runApprovedLocalBrowserAction(runId, {
        sessionId,
        projectId: botId,
        objective: `Run ${skill.name}: ${stepLabel(step, recipe)}`,
        approvalSha256: approval.sha256,
        toolInputs: inputs,
      }, recordEvent);
      if (finished.current) return;
      toolInputs.current = null;
      currentApproval.current = null;
      if (step.inputId) {
        setValues((current) => ({ ...current, [step.inputId!]: "" }));
        valuesRef.current = { ...valuesRef.current, [step.inputId]: "" };
      }
      if (result.status !== "completed" || result.failure) {
        const uncertain = result.failure?.uncertainWrite
          ? " The page may have received the action, so Codelit will not retry it automatically."
          : "";
        throw new Error(`The reviewed browser step did not finish.${uncertain}`);
      }
      completedStepIds.current.push(step.id);
      automatedSteps.current += 1;
      proofs.current.push(...result.browserProofs);
      completedTools.current.push(...result.completedTools);
      await onCheckpoint({
        stepIndex: activeIndex + 1,
        handoff: `${skill.name}: ${stepLabel(step, recipe)} completed`,
        priorSteps: completedStepIds.current.map((id) => ({ id, status: "completed" })),
        gateApproved: true,
        runContext: {
          kind: "browser-skill-replay",
          skillId: skill.id,
          skillVersion: skill.version,
          completedStepIds: [...completedStepIds.current],
          automatedSteps: automatedSteps.current,
          takeoverSteps: takeoverSteps.current,
        },
      });
      await prepareStep(activeIndex + 1);
    } catch (reason) {
      if (finished.current) return;
      await fail(reason);
    }
  };

  const takeOver = async () => {
    const approval = currentApproval.current;
    if (!approval || phase !== "takeover") return;
    setError(null);
    try {
      await onApproval({ id: approval.id, stepIndex: activeIndex, status: "approved", body: {
        ...(approval.body as Record<string, unknown>),
        decisionSource: "user-takeover",
      } });
      setPreview({
        summary: "You have control of this protected step.",
        evidence: ["Codelit will not click, type, upload, download, sign in, or submit this step for you."],
      });
    } catch (reason) {
      await fail(reason);
    }
  };

  const finishTakeover = async () => {
    const step = currentStep;
    if (!step || phase !== "takeover") return;
    setError(null);
    try {
      const nextCompletedStepIds = [...completedStepIds.current, step.id];
      const nextTakeoverSteps = takeoverSteps.current + 1;
      await onCheckpoint({
        stepIndex: activeIndex + 1,
        handoff: `${skill.name}: protected step returned by the user`,
        priorSteps: nextCompletedStepIds.map((id) => ({ id, status: "completed" })),
        gateApproved: true,
        runContext: {
          kind: "browser-skill-replay",
          skillId: skill.id,
          skillVersion: skill.version,
          completedStepIds: nextCompletedStepIds,
          automatedSteps: automatedSteps.current,
          takeoverSteps: nextTakeoverSteps,
        },
      });
      completedStepIds.current = nextCompletedStepIds;
      takeoverSteps.current = nextTakeoverSteps;
      currentApproval.current = null;
      await prepareStep(activeIndex + 1);
    } catch (reason) {
      if (finished.current) return;
      await fail(reason);
    }
  };

  return (
    <article className="bot-browser-replay" data-phase={phase} role="region" aria-label={`Run ${skill.name}`}>
      <header>
        <span className="bot-replay-icon"><Play size={13} /></span>
        <div>
          <strong>{skill.name}</strong>
          <span>{phase === "inputs"
            ? "Add run-time values. They will not be saved."
            : `${Math.min(activeIndex + 1, steps.length)} of ${steps.length} · ${currentStep ? stepLabel(currentStep, recipe) : "Finishing"}`}</span>
        </div>
        <button type="button" className="bots-icon-button" onClick={() => void hold()} aria-label={`Stop ${skill.name}`} title="Stop">
          <X size={14} />
        </button>
      </header>

      {phase === "inputs" && (
        <form className="bot-replay-inputs" onSubmit={(event) => { event.preventDefault(); void begin(); }}>
          <div>
            {recipe.inputs.map((input) => (
              <label key={input.id}>
                <span>{input.label}</span>
                <input
                  type={input.type}
                  value={values[input.id] || ""}
                  onChange={(event) => setValues((current) => ({ ...current, [input.id]: event.target.value }))}
                  maxLength={4_000}
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              </label>
            ))}
          </div>
          {error && <p role="alert"><CircleAlert size={13} /> {error}</p>}
          <footer>
            <span><ShieldCheck size={13} /> Values stay in memory only for this run.</span>
            <button type="submit" className="bot-primary-action"><Play size={13} /> Start</button>
          </footer>
        </form>
      )}

      {phase === "queued" && (
        <div className="bot-replay-review" role="status">
          <span className="bot-replay-step-icon"><ShieldCheck size={14} /></span>
          <div>
            <strong>Waiting for the private browser</strong>
            <span>Codelit runs one visible browser task at a time.</span>
          </div>
          <footer><span className="bot-replay-progress">Waiting...</span></footer>
        </div>
      )}

      {phase !== "inputs" && phase !== "queued" && (
        <>
          <div className="bot-replay-review" role="group" aria-label="Exact browser action review">
            <span className="bot-replay-step-icon">{currentStep?.type === "fill"
              ? <TextCursorInput size={14} />
              : currentStep?.risk !== "none"
                ? <Hand size={14} />
                : <MousePointerClick size={14} />}</span>
            <div>
              <strong>{phase === "opening"
                ? "Opening the approved website"
                : phase === "preparing"
                  ? "Rechecking the exact target"
                  : currentStep ? stepLabel(currentStep, recipe) : "Finishing"}</strong>
              <span>{preview?.summary || (currentStep?.risk !== "none"
                ? "This step stays under your control."
                : "Codelit asks again before every click or typed value.")}</span>
              {preview && currentStep && <small>{redactedPreviewDetail(currentStep, preview.evidence)}</small>}
              {error && <small className="bot-replay-error"><CircleAlert size={12} /> {error}</small>}
            </div>
            <footer>
              {phase === "awaiting" && (
                <>
                  <button type="button" className="bot-secondary-action" onClick={() => void hold()}>Hold</button>
                  <button type="button" className="bot-primary-action" onClick={() => void allowOnce()}>Allow once</button>
                </>
              )}
              {phase === "takeover" && !preview && (
                <>
                  <button type="button" className="bot-secondary-action" onClick={() => void hold()}>Hold</button>
                  <button type="button" className="bot-primary-action" onClick={() => void takeOver()}><Hand size={13} /> Take over</button>
                </>
              )}
              {phase === "takeover" && preview && (
                <button type="button" className="bot-primary-action" onClick={() => void finishTakeover()}><Check size={13} /> I finished this step</button>
              )}
              {["opening", "preparing", "running"].includes(phase) && <span className="bot-replay-progress">Working...</span>}
            </footer>
          </div>
          <div className="bots-browser-run">
            <LocalBrowserPanel
              sessionId={sessionId}
              projectId={botId}
              initialUrl={recipe.startUrl}
              allowedDomains={recipe.approvedDomains}
              obscured={obscured}
              disabled={phase !== "takeover" || !preview}
              mode="replay"
              onSessionChange={onSessionChange}
              onOpenError={(message) => void fail(message)}
              onRequestCloudBrowser={() => undefined}
            />
          </div>
        </>
      )}
    </article>
  );
}
