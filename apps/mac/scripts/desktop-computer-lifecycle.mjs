import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { candidateFingerprint } from "./desktop-candidate-qa.mjs";
import { directCandidateIsValid, sameCandidate } from "./desktop-p1-journey.mjs";

export const desktopComputerLifecycleGate = "p5-computer-lifecycle";
export const desktopComputerLifecycleAttestation =
  "I completed every recorded lifecycle check against this exact signed Direct candidate and reviewed each distinct proof bundle.";

export const desktopComputerLifecycleChecks = [
  {
    id: "stable-action",
    label: "Complete one approved action with an unchanged awake display configuration",
    actionDispatched: true,
    runStatus: "completed",
    environmentStatus: "ready",
    continuity: "continuous",
    topology: "stable",
    actionOutcome: "completed",
    proofCount: 2,
    minimumDisplayCount: 1,
  },
  {
    id: "stable-multi-display",
    label: "Complete one approved action while at least two displays remain active",
    actionDispatched: true,
    runStatus: "completed",
    environmentStatus: "ready",
    continuity: "continuous",
    topology: "stable",
    actionOutcome: "completed",
    proofCount: 2,
    minimumDisplayCount: 2,
  },
  {
    id: "locked-session",
    label: "Refuse an action while the macOS session is locked and recover after unlock",
    actionDispatched: false,
    runStatus: "failed-before-action",
    environmentStatus: "locked",
    continuity: "not-started",
    topology: "not-observed",
    actionOutcome: "unchanged",
    proofCount: 0,
    minimumDisplayCount: 0,
  },
  {
    id: "sleep-wake",
    label: "Lose continuity across sleep and wake without automatically retrying",
    actionDispatched: true,
    runStatus: "continuity-lost",
    environmentStatus: "ready",
    continuity: "interrupted-after-dispatch",
    topology: "stable",
    actionOutcome: "uncertain",
    proofCount: 1,
    minimumDisplayCount: 1,
  },
  {
    id: "display-asleep",
    label: "Refuse an action while an active display is asleep and recover after wake",
    actionDispatched: false,
    runStatus: "failed-before-action",
    environmentStatus: "display-asleep",
    continuity: "not-started",
    topology: "not-observed",
    actionOutcome: "unchanged",
    proofCount: 0,
    minimumDisplayCount: 0,
  },
  {
    id: "display-topology-change",
    label: "Lose continuity when the active display topology changes during an action",
    actionDispatched: true,
    runStatus: "continuity-lost",
    environmentStatus: "ready",
    continuity: "interrupted-after-dispatch",
    topology: "changed",
    actionOutcome: "uncertain",
    proofCount: 1,
    minimumDisplayCount: 1,
  },
  {
    id: "accessibility-revoked",
    label: "Refuse an action after Accessibility permission is revoked and recover after regrant",
    actionDispatched: false,
    runStatus: "failed-before-action",
    environmentStatus: "accessibility-required",
    continuity: "not-started",
    topology: "not-observed",
    actionOutcome: "unchanged",
    proofCount: 0,
    minimumDisplayCount: 1,
  },
  {
    id: "screen-recording-revoked",
    label: "Refuse an action after Screen Recording permission is revoked and recover after regrant",
    actionDispatched: false,
    runStatus: "failed-before-action",
    environmentStatus: "screen-recording-required",
    continuity: "not-started",
    topology: "not-observed",
    actionOutcome: "unchanged",
    proofCount: 0,
    minimumDisplayCount: 1,
  },
  {
    id: "approved-app-exit",
    label: "Refuse an action when the approved app exits before dispatch",
    actionDispatched: false,
    runStatus: "failed-before-action",
    environmentStatus: "ready",
    continuity: "not-started",
    topology: "not-observed",
    actionOutcome: "unchanged",
    proofCount: 0,
    minimumDisplayCount: 1,
  },
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isoTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function evidenceDigest(value) {
  return /^[a-f0-9]{64}$/.test(value || "");
}

function targetAppIsValid(targetApp) {
  return typeof targetApp?.name === "string"
    && targetApp.name.trim() === targetApp.name
    && targetApp.name.length > 0
    && targetApp.name.length <= 80
    && typeof targetApp?.bundleId === "string"
    && /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(targetApp.bundleId)
    && targetApp.bundleId !== "io.codelit.desktop";
}

function sameEvidence(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function computerLifecycleEvidenceFile(path, id) {
  const absolute = resolve(path);
  if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isFile()) {
    throw new Error(`Computer lifecycle evidence ${id} must be a non-symlink regular file.`);
  }
  const bytes = readFileSync(absolute);
  if (!bytes.length || bytes.length > 64 * 1024 * 1024) {
    throw new Error(`Computer lifecycle evidence ${id} is empty or exceeds 64 MB.`);
  }
  return { id, result: "passed", bytes: bytes.length, sha256: sha256(bytes) };
}

export function computerLifecycleEvidenceFingerprint(evidence) {
  return sha256(JSON.stringify(evidence));
}

export function createDesktopComputerLifecycleObservationDraft() {
  return {
    schemaVersion: 1,
    startedAt: "RECORD_EXACT_UTC",
    completedAt: "RECORD_EXACT_UTC",
    macOSVersion: "RECORD_EXACT_VERSION",
    targetApp: {
      name: "RECORD_APPROVED_APP_NAME",
      bundleId: "RECORD.APP.BUNDLE_ID",
    },
    checks: desktopComputerLifecycleChecks.map((check) => ({
      id: check.id,
      actionDispatched: check.actionDispatched,
      runStatus: check.runStatus,
      environmentStatus: check.environmentStatus,
      continuity: check.continuity,
      topology: check.topology,
      actionOutcome: check.actionOutcome,
      proofCount: check.proofCount,
      activeDisplayCount: check.minimumDisplayCount,
      recoveredStatus: "ready",
      automaticRetry: false,
      evidencePath: `/absolute/path/${check.id}-evidence.zip`,
    })),
  };
}

function observationIssues(observation, expected) {
  const issues = [];
  if (observation?.actionDispatched !== expected.actionDispatched) issues.push("dispatch state");
  if (observation?.runStatus !== expected.runStatus) issues.push("run status");
  if (observation?.environmentStatus !== expected.environmentStatus) issues.push("environment status");
  if (observation?.continuity !== expected.continuity) issues.push("continuity state");
  if (observation?.topology !== expected.topology) issues.push("topology result");
  if (observation?.actionOutcome !== expected.actionOutcome) issues.push("action outcome");
  if (observation?.proofCount !== expected.proofCount) issues.push("proof count");
  if (
    !Number.isSafeInteger(observation?.activeDisplayCount)
    || observation.activeDisplayCount < expected.minimumDisplayCount
    || observation.activeDisplayCount > 16
  ) {
    issues.push("active display count");
  }
  if (observation?.recoveredStatus !== "ready") issues.push("recovery state");
  if (observation?.automaticRetry !== false) issues.push("automatic retry state");
  const evidence = observation?.evidence;
  if (
    evidence?.id !== expected.id
    || evidence?.result !== "passed"
    || !Number.isSafeInteger(evidence?.bytes)
    || evidence.bytes <= 0
    || !evidenceDigest(evidence?.sha256)
  ) {
    issues.push("evidence");
  }
  return issues;
}

export function createDesktopComputerLifecycleReceipt({
  candidate,
  startedAt,
  completedAt,
  macOSVersion,
  targetApp,
  checks,
  signedAt,
}) {
  const receipt = {
    schemaVersion: 1,
    gate: desktopComputerLifecycleGate,
    status: "passed",
    channel: "direct",
    startedAt,
    completedAt,
    durationMs: new Date(completedAt).valueOf() - new Date(startedAt).valueOf(),
    candidate,
    candidateFingerprint: candidateFingerprint(candidate),
    environment: {
      architecture: "arm64",
      macOSVersion,
    },
    targetApp,
    checks,
    evidenceFingerprint: computerLifecycleEvidenceFingerprint(checks.map((check) => check.evidence)),
    attestation: {
      role: "release-owner",
      statement: desktopComputerLifecycleAttestation,
      signedAt,
    },
  };
  const issues = desktopComputerLifecycleReceiptIssues(receipt, { candidate });
  if (issues.length) throw new Error(`Computer lifecycle receipt is invalid: ${issues.join(" ")}`);
  return receipt;
}

/**
 * @param {any} receipt
 * @param {{ candidate?: any, evidence?: any[], checks?: any[] }} [options]
 */
export function desktopComputerLifecycleReceiptIssues(
  receipt,
  { candidate, evidence: exactEvidence, checks: exactChecks } = {},
) {
  const issues = [];
  if (receipt?.schemaVersion !== 1 || receipt?.gate !== desktopComputerLifecycleGate) {
    issues.push("The computer lifecycle receipt has an unsupported contract.");
  }
  if (receipt?.status !== "passed" || receipt?.channel !== "direct") {
    issues.push("The computer lifecycle matrix must pass on the signed Direct candidate.");
  }
  if (!directCandidateIsValid(receipt?.candidate)) {
    issues.push("The computer lifecycle matrix is missing a valid Developer ID-signed Direct candidate.");
  }
  if (candidateFingerprint(receipt?.candidate || null) !== receipt?.candidateFingerprint) {
    issues.push("The computer lifecycle candidate fingerprint is invalid.");
  }
  if (candidate && !sameCandidate(receipt?.candidate, candidate)) {
    issues.push("The computer lifecycle receipt belongs to different signed artifacts.");
  }

  const startedAt = receipt?.startedAt;
  const completedAt = receipt?.completedAt;
  const started = isoTimestamp(startedAt) ? new Date(startedAt).valueOf() : Number.NaN;
  const completed = isoTimestamp(completedAt) ? new Date(completedAt).valueOf() : Number.NaN;
  if (!Number.isFinite(started) || !Number.isFinite(completed)) {
    issues.push("The computer lifecycle matrix needs exact UTC start and completion times.");
  } else {
    const duration = completed - started;
    if (duration <= 0 || duration > 8 * 60 * 60 * 1_000 || receipt?.durationMs !== duration) {
      issues.push("The computer lifecycle matrix must finish within eight hours with an exact duration.");
    }
  }
  if (
    receipt?.environment?.architecture !== "arm64"
    || !/^\d+(?:\.\d+){1,2}$/.test(receipt?.environment?.macOSVersion || "")
  ) {
    issues.push("The computer lifecycle matrix needs an exact Apple Silicon macOS environment.");
  }
  if (!targetAppIsValid(receipt?.targetApp)) {
    issues.push("The computer lifecycle matrix needs one explicit non-Codelit target app.");
  }

  const checks = Array.isArray(receipt?.checks) ? receipt.checks : [];
  for (const expected of desktopComputerLifecycleChecks) {
    const matches = checks.filter((check) => check?.id === expected.id);
    if (matches.length !== 1) {
      issues.push(`The computer lifecycle check ${expected.id} must appear exactly once.`);
      continue;
    }
    const checkIssues = observationIssues(matches[0], expected);
    if (checkIssues.length) {
      issues.push(`The computer lifecycle check ${expected.id} has invalid ${checkIssues.join(", ")}.`);
    }
  }
  if (checks.some((check) => !desktopComputerLifecycleChecks.some((expected) => expected.id === check?.id))) {
    issues.push("The computer lifecycle receipt contains an unexpected check.");
  }
  const evidence = checks.map((check) => check?.evidence);
  if (new Set(evidence.map((entry) => entry?.sha256)).size !== desktopComputerLifecycleChecks.length) {
    issues.push("Each computer lifecycle check needs distinct evidence.");
  }
  if (receipt?.evidenceFingerprint !== computerLifecycleEvidenceFingerprint(evidence)) {
    issues.push("The computer lifecycle evidence fingerprint is invalid.");
  }
  if (exactEvidence && !sameEvidence(evidence, exactEvidence)) {
    issues.push("The computer lifecycle receipt does not match the supplied proof files.");
  }
  if (exactChecks && !sameEvidence(checks, exactChecks)) {
    issues.push("The computer lifecycle receipt does not match the supplied observations.");
  }

  const attestation = receipt?.attestation;
  if (
    attestation?.role !== "release-owner"
    || attestation?.statement !== desktopComputerLifecycleAttestation
    || !isoTimestamp(attestation?.signedAt)
  ) {
    issues.push("The computer lifecycle receipt is missing its release-owner attestation.");
  } else if (Number.isFinite(completed) && attestation.signedAt < completedAt) {
    issues.push("The computer lifecycle attestation cannot precede completion.");
  }
  return [...new Set(issues)];
}

export function readDesktopComputerLifecycleReceipt(path) {
  const absolute = resolve(path);
  if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isFile()) {
    throw new Error("The computer lifecycle receipt must be a non-symlink regular file.");
  }
  const bytes = readFileSync(absolute);
  if (!bytes.length || bytes.length > 512 * 1024) {
    throw new Error("The computer lifecycle receipt is empty or too large.");
  }
  return JSON.parse(bytes.toString("utf8"));
}

export function readDesktopComputerLifecycleObservations(path) {
  const absolute = resolve(path);
  if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isFile()) {
    throw new Error("The computer lifecycle observations must be a non-symlink regular file.");
  }
  const bytes = readFileSync(absolute);
  if (!bytes.length || bytes.length > 512 * 1024) {
    throw new Error("The computer lifecycle observations are empty or too large.");
  }
  return JSON.parse(bytes.toString("utf8"));
}

export function observationsWithEvidence(observations) {
  if (observations?.schemaVersion !== 1 || !Array.isArray(observations?.checks)) {
    throw new Error("The computer lifecycle observations have an unsupported contract.");
  }
  return observations.checks.map((check) => {
    if (typeof check?.evidencePath !== "string" || !check.evidencePath.startsWith("/")) {
      throw new Error(`Computer lifecycle check ${check?.id || "unknown"} needs an absolute evidence path.`);
    }
    const { evidencePath, ...observation } = check;
    return {
      ...observation,
      evidence: computerLifecycleEvidenceFile(evidencePath, observation.id),
    };
  });
}
