import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { candidateFingerprint } from "./desktop-candidate-qa.mjs";

export const desktopP1JourneyGate = "p1-one-bot-real-work";
export const desktopP1JourneyAttestation =
  "I completed the recorded journey against this exact signed Direct candidate and reviewed every attached proof.";

export const desktopP1JourneyEvidence = [
  { id: "allow-once", label: "The approval showed the exact host and Allow once was selected" },
  { id: "in-window-webkit", label: "The approved page opened and was read inside Codelit's WebKit window" },
  { id: "codex-result", label: "The signed-in Codex subscription returned a useful grounded result" },
  { id: "durable-receipt", label: "The completed run exposed its local receipt with no metered fallback" },
  { id: "relaunch-restore", label: "The conversation and exact receipt remained after quit and relaunch" },
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

function publicHost(value) {
  return typeof value === "string"
    && value.length <= 253
    && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value);
}

function comparableCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") return candidate;
  return {
    channel: candidate.channel,
    bundleIdentifier: candidate.bundleIdentifier,
    version: candidate.version,
    build: candidate.build,
    minimumSystemVersion: candidate.minimumSystemVersion,
    source: candidate.source,
    app: candidate.app,
    artifacts: Array.isArray(candidate.artifacts)
      ? candidate.artifacts
        .map(({ role, bytes, sha256: digest }) => ({ role, bytes, sha256: digest }))
        .sort((left, right) => left.role.localeCompare(right.role))
      : candidate.artifacts,
  };
}

export function sameCandidate(left, right) {
  return JSON.stringify(comparableCandidate(left)) === JSON.stringify(comparableCandidate(right));
}

function sameEvidence(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function directCandidateIsValid(candidate) {
  const artifacts = Array.isArray(candidate?.artifacts) ? candidate.artifacts : [];
  const roles = artifacts.map((artifact) => artifact?.role).sort();
  return candidate?.channel === "direct"
    && candidate?.bundleIdentifier === "io.codelit.desktop"
    && /^\d+\.\d+\.\d+$/.test(candidate?.version || "")
    && /^[1-9]\d{0,17}$/.test(candidate?.build || "")
    && candidate?.minimumSystemVersion === "14.0"
    && /^[a-f0-9]{40}$/.test(candidate?.source?.commit || "")
    && candidate?.source?.dirty === false
    && /^[a-f0-9]{40}$/.test(candidate?.app?.cdHash || "")
    && /^[a-f0-9]{64}$/.test(candidate?.app?.executableSha256 || "")
    && /^[A-Z0-9]{10}$/.test(candidate?.app?.teamIdentifier || "")
    && candidate?.app?.authorities?.[0]?.startsWith("Developer ID Application:")
    && candidate?.app?.hardenedRuntime === true
    && candidate?.app?.sandboxed === false
    && JSON.stringify(roles) === JSON.stringify(["dmg", "updater-archive"])
    && artifacts.every((artifact) => (
      Number.isSafeInteger(artifact?.bytes)
      && artifact.bytes > 0
      && /^[a-f0-9]{64}$/.test(artifact?.sha256 || "")
    ));
}

export function p1EvidenceFile(path, id) {
  const absolute = resolve(path);
  if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isFile()) {
    throw new Error(`P1 evidence ${id} must be a non-symlink regular file.`);
  }
  const bytes = readFileSync(absolute);
  if (!bytes.length || bytes.length > 64 * 1024 * 1024) {
    throw new Error(`P1 evidence ${id} is empty or exceeds 64 MB.`);
  }
  return { id, result: "passed", bytes: bytes.length, sha256: sha256(bytes) };
}

export function p1EvidenceFingerprint(evidence) {
  return sha256(JSON.stringify(evidence));
}

export function createDesktopP1JourneyReceipt({
  candidate,
  startedAt,
  completedAt,
  macOSVersion,
  host,
  evidence,
  signedAt,
}) {
  const started = new Date(startedAt).valueOf();
  const completed = new Date(completedAt).valueOf();
  const receipt = {
    schemaVersion: 1,
    gate: desktopP1JourneyGate,
    status: "passed",
    channel: "direct",
    startedAt,
    completedAt,
    durationMs: completed - started,
    candidate,
    candidateFingerprint: candidateFingerprint(candidate),
    environment: {
      architecture: "arm64",
      macOSVersion,
      freshProfile: true,
    },
    journey: {
      host,
      approval: "allow-once",
      browser: {
        surface: "in-window-webkit",
        mode: "read-only",
        status: "completed",
      },
      provider: {
        id: "codex",
        access: "signed-in-subscription",
        status: "completed",
        noMeteredFallback: true,
      },
      result: "completed",
      receipt: "completed",
      relaunchRestored: true,
    },
    evidence,
    evidenceFingerprint: p1EvidenceFingerprint(evidence),
    attestation: {
      role: "release-owner",
      statement: desktopP1JourneyAttestation,
      signedAt,
    },
  };
  const issues = desktopP1JourneyReceiptIssues(receipt, { candidate });
  if (issues.length) throw new Error(`P1 journey receipt is invalid: ${issues.join(" ")}`);
  return receipt;
}

/**
 * @param {any} receipt
 * @param {{ candidate?: any, evidence?: any[] }} [options]
 */
export function desktopP1JourneyReceiptIssues(receipt, { candidate, evidence: exactEvidence } = {}) {
  const issues = [];
  if (receipt?.schemaVersion !== 1 || receipt?.gate !== desktopP1JourneyGate) {
    issues.push("The P1 journey receipt has an unsupported contract.");
  }
  if (receipt?.status !== "passed" || receipt?.channel !== "direct") {
    issues.push("The P1 journey must pass on the signed Direct candidate.");
  }
  if (!directCandidateIsValid(receipt?.candidate)) {
    issues.push("The P1 journey is missing a valid Developer ID-signed Direct candidate.");
  }
  if (candidateFingerprint(receipt?.candidate || null) !== receipt?.candidateFingerprint) {
    issues.push("The P1 journey candidate fingerprint is invalid.");
  }
  if (candidate && !sameCandidate(receipt?.candidate, candidate)) {
    issues.push("The P1 journey belongs to different signed artifacts.");
  }

  const startedAt = receipt?.startedAt;
  const completedAt = receipt?.completedAt;
  const started = isoTimestamp(startedAt) ? new Date(startedAt).valueOf() : Number.NaN;
  const completed = isoTimestamp(completedAt) ? new Date(completedAt).valueOf() : Number.NaN;
  if (!Number.isFinite(started) || !Number.isFinite(completed)) {
    issues.push("The P1 journey needs exact UTC start and completion times.");
  } else {
    const duration = completed - started;
    if (duration <= 0 || duration > 5 * 60 * 1_000 || receipt?.durationMs !== duration) {
      issues.push("The P1 journey must complete in under five minutes with an exact duration.");
    }
  }

  if (
    receipt?.environment?.architecture !== "arm64"
    || !/^\d+(?:\.\d+){1,2}$/.test(receipt?.environment?.macOSVersion || "")
    || receipt?.environment?.freshProfile !== true
  ) {
    issues.push("The P1 journey needs an exact Apple Silicon fresh-profile environment.");
  }

  const journey = receipt?.journey;
  if (!publicHost(journey?.host)) {
    issues.push("The P1 journey must inspect one explicit public host.");
  }
  if (
    journey?.approval !== "allow-once"
    || journey?.browser?.surface !== "in-window-webkit"
    || journey?.browser?.mode !== "read-only"
    || journey?.browser?.status !== "completed"
  ) {
    issues.push("The P1 journey is missing its one-time in-window read proof.");
  }
  if (
    journey?.provider?.id !== "codex"
    || journey?.provider?.access !== "signed-in-subscription"
    || journey?.provider?.status !== "completed"
    || journey?.provider?.noMeteredFallback !== true
  ) {
    issues.push("The P1 journey must complete with the signed-in Codex subscription and no metered fallback.");
  }
  if (journey?.result !== "completed" || journey?.receipt !== "completed" || journey?.relaunchRestored !== true) {
    issues.push("The P1 journey must preserve the completed result and receipt after relaunch.");
  }

  const evidence = Array.isArray(receipt?.evidence) ? receipt.evidence : [];
  for (const expected of desktopP1JourneyEvidence) {
    const matches = evidence.filter((entry) => entry?.id === expected.id);
    if (
      matches.length !== 1
      || matches[0]?.result !== "passed"
      || !Number.isSafeInteger(matches[0]?.bytes)
      || matches[0].bytes <= 0
      || !evidenceDigest(matches[0]?.sha256)
    ) {
      issues.push(`The P1 journey evidence ${expected.id} is incomplete.`);
    }
  }
  if (evidence.some((entry) => !desktopP1JourneyEvidence.some((expected) => expected.id === entry?.id))) {
    issues.push("The P1 journey contains unexpected evidence.");
  }
  if (new Set(evidence.map((entry) => entry?.sha256)).size !== desktopP1JourneyEvidence.length) {
    issues.push("Each P1 journey step needs distinct evidence.");
  }
  if (receipt?.evidenceFingerprint !== p1EvidenceFingerprint(evidence)) {
    issues.push("The P1 journey evidence fingerprint is invalid.");
  }
  if (exactEvidence && !sameEvidence(evidence, exactEvidence)) {
    issues.push("The P1 journey evidence does not match the supplied proof files.");
  }

  const attestation = receipt?.attestation;
  if (
    attestation?.role !== "release-owner"
    || attestation?.statement !== desktopP1JourneyAttestation
    || !isoTimestamp(attestation?.signedAt)
  ) {
    issues.push("The P1 journey is missing its release-owner attestation.");
  } else if (Number.isFinite(completed) && attestation.signedAt < completedAt) {
    issues.push("The P1 journey attestation cannot precede completion.");
  }
  return [...new Set(issues)];
}

export function readDesktopP1JourneyReceipt(path) {
  const absolute = resolve(path);
  if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isFile()) {
    throw new Error("The P1 journey receipt must be a non-symlink regular file.");
  }
  const bytes = readFileSync(absolute);
  if (!bytes.length || bytes.length > 512 * 1024) {
    throw new Error("The P1 journey receipt is empty or too large.");
  }
  return JSON.parse(bytes.toString("utf8"));
}
