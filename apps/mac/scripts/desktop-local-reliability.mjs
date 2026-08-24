import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  candidateDescriptorIssues,
  candidateFingerprint,
} from "./desktop-candidate-qa.mjs";
import { sameCandidate } from "./desktop-p1-journey.mjs";

export const desktopLocalReliabilityGate = "p7-local-reliability";
export const desktopLocalReliabilityAttestation =
  "I completed every recorded local reliability check against this exact signed candidate and reviewed each distinct proof bundle.";

export const desktopLocalReliabilityChecks = [
  { id: "assistive-access", label: "Complete the core bot journey with keyboard, VoiceOver, contrast, and reduced-motion settings" },
  { id: "idle-energy", label: "Measure near-zero idle work without spontaneous runs or network activity" },
  { id: "thermal-backpressure", label: "Verify the exact binary applies every resource-pressure boundary" },
  { id: "two-version-migration", label: "Upgrade two schema versions without loss and refuse a downgrade" },
  { id: "offline-local-run", label: "Complete one local-model run offline without metered fallback" },
  { id: "checkpoint-recovery", label: "Recover a killed run from its last checkpoint without repeating an action" },
];

export const expectedResourcePolicyMatrix = [
  { id: "nominal", thermalState: "nominal", lowPowerMode: false, availableMemoryBytes: 12 * 1024 ** 3, mlxDownload: "allowed", mlxBenchmark: "allowed", mlxInference: "allowed", maxParallel: 2 },
  { id: "fair", thermalState: "fair", lowPowerMode: false, availableMemoryBytes: 12 * 1024 ** 3, mlxDownload: "allowed", mlxBenchmark: "allowed", mlxInference: "allowed", maxParallel: 1 },
  { id: "low-power", thermalState: "nominal", lowPowerMode: true, availableMemoryBytes: 12 * 1024 ** 3, mlxDownload: "blocked", mlxBenchmark: "blocked", mlxInference: "allowed", maxParallel: 1 },
  { id: "serious", thermalState: "serious", lowPowerMode: false, availableMemoryBytes: 12 * 1024 ** 3, mlxDownload: "blocked", mlxBenchmark: "blocked", mlxInference: "blocked", maxParallel: 0 },
  { id: "critical", thermalState: "critical", lowPowerMode: false, availableMemoryBytes: 12 * 1024 ** 3, mlxDownload: "blocked", mlxBenchmark: "blocked", mlxInference: "blocked", maxParallel: 0 },
  { id: "constrained-memory", thermalState: "nominal", lowPowerMode: false, availableMemoryBytes: 4 * 1024 ** 3, mlxDownload: "allowed", mlxBenchmark: "allowed", mlxInference: "allowed", maxParallel: 1 },
  { id: "critical-memory", thermalState: "nominal", lowPowerMode: false, availableMemoryBytes: 1024 ** 3, mlxDownload: "allowed", mlxBenchmark: "allowed", mlxInference: "allowed", maxParallel: 0 },
];

const artifactCountKeys = [
  "bots",
  "threads",
  "runs",
  "routines",
  "skills",
  "memories",
  "localTables",
  "browserSessions",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isoTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function digestIsValid(value) {
  return /^[a-f0-9]{64}$/.test(value || "");
}

function boundedJsonFile(path, label, maximumBytes = 1024 * 1024) {
  const absolute = resolve(path);
  if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isFile()) {
    throw new Error(`${label} must be a non-symlink regular file.`);
  }
  const bytes = readFileSync(absolute);
  if (!bytes.length || bytes.length > maximumBytes) throw new Error(`${label} is empty or too large.`);
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

export function localReliabilityEvidenceFile(path, id) {
  const absolute = resolve(path);
  if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isFile()) {
    throw new Error(`Local reliability evidence ${id} must be a non-symlink regular file.`);
  }
  const bytes = readFileSync(absolute);
  if (!bytes.length || bytes.length > 128 * 1024 * 1024) {
    throw new Error(`Local reliability evidence ${id} is empty or exceeds 128 MB.`);
  }
  return { id, result: "passed", bytes: bytes.length, sha256: sha256(bytes) };
}

export function localReliabilityEvidenceFingerprint(evidence) {
  return sha256(JSON.stringify(evidence));
}

function releaseCandidateIssues(candidate) {
  if (!candidate || !["direct", "app-store"].includes(candidate.channel)) {
    return ["The local reliability receipt has an unsupported release channel."];
  }
  return candidateDescriptorIssues(candidate, candidate.channel);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function expectedProbeCase(id) {
  return expectedResourcePolicyMatrix.find((entry) => entry.id === id);
}

export function resourcePolicyProbeIssues(probe, { candidate } = {}) {
  const issues = [];
  if (probe?.schemaVersion !== 1) issues.push("The resource-policy probe schema is unsupported.");
  if (probe?.bundleIdentifier !== "io.codelit.desktop") issues.push("The resource-policy probe has the wrong bundle identifier.");
  if (!/^(direct|app-store)$/.test(probe?.channel || "")) issues.push("The resource-policy probe has an unsupported channel.");
  if (!/^\d+\.\d+\.\d+$/.test(probe?.version || "")) issues.push("The resource-policy probe is missing its version.");
  if (!/^[a-f0-9]{40}$/.test(probe?.sourceCommit || "") || probe?.sourceDirty !== false) {
    issues.push("The resource-policy probe must identify one clean source commit.");
  }
  if (!digestIsValid(probe?.executableSha256)) issues.push("The resource-policy probe is missing its executable digest.");
  const live = probe?.live;
  if (
    !["nominal", "fair", "serious", "critical", "unknown"].includes(live?.thermalState)
    || typeof live?.lowPowerMode !== "boolean"
    || typeof live?.availableMemoryKnown !== "boolean"
    || !Number.isSafeInteger(live?.availableMemoryBytes)
    || live.availableMemoryBytes < 0
    || live.availableMemoryKnown !== (live.availableMemoryBytes > 0)
    || !Number.isSafeInteger(live?.maxParallel)
    || live.maxParallel < 0
    || live.maxParallel > 2
  ) {
    issues.push("The resource-policy probe has an invalid live resource snapshot.");
  }
  const matrix = Array.isArray(probe?.matrix) ? probe.matrix : [];
  for (const expected of expectedResourcePolicyMatrix) {
    const matches = matrix.filter((entry) => entry?.id === expected.id);
    if (matches.length !== 1 || !sameValue(matches[0], expected)) {
      issues.push(`The resource-policy probe case ${expected.id} is invalid.`);
    }
  }
  if (matrix.some((entry) => !expectedProbeCase(entry?.id))) {
    issues.push("The resource-policy probe contains an unexpected case.");
  }
  if (candidate) {
    if (
      probe?.channel !== candidate.channel
      || probe?.version !== candidate.version
      || probe?.sourceCommit !== candidate.source?.commit
      || probe?.executableSha256 !== candidate.app?.executableSha256
    ) {
      issues.push("The resource-policy probe belongs to different candidate bytes.");
    }
  }
  return [...new Set(issues)];
}

export function readResourcePolicyProbe(path, { candidate } = {}) {
  const { bytes, value } = boundedJsonFile(path, "Resource-policy probe");
  const issues = resourcePolicyProbeIssues(value, { candidate });
  if (issues.length) throw new Error(issues.join(" "));
  return {
    probe: value,
    evidence: {
      id: "resource-policy-probe",
      result: "passed",
      bytes: bytes.length,
      sha256: sha256(bytes),
    },
  };
}

function countsAreValid(value) {
  return value
    && Object.keys(value).sort().join("|") === [...artifactCountKeys].sort().join("|")
    && artifactCountKeys.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)
    && artifactCountKeys.some((key) => value[key] > 0);
}

function countsMatch(left, right) {
  return countsAreValid(left)
    && countsAreValid(right)
    && artifactCountKeys.every((key) => left[key] === right[key]);
}

function evidenceIsValid(value, id) {
  return value?.id === id
    && value?.result === "passed"
    && Number.isSafeInteger(value?.bytes)
    && value.bytes > 0
    && digestIsValid(value?.sha256);
}

function observationIssues(observation, candidate) {
  const issues = [];
  switch (observation?.id) {
    case "assistive-access":
      if (
        observation.keyboardOnlyCompleted !== true
        || observation.voiceOverCompleted !== true
        || observation.increasedContrastCompleted !== true
        || observation.reducedMotionCompleted !== true
        || observation.unlabelledControlCount !== 0
        || observation.focusOrderIssueCount !== 0
        || observation.blockedControlCount !== 0
      ) issues.push("assistive journey");
      break;
    case "idle-energy":
      if (!Number.isFinite(observation.durationSeconds) || observation.durationSeconds < 300 || observation.durationSeconds > 3_600) issues.push("sample duration");
      if (!Number.isSafeInteger(observation.sampleCount) || observation.sampleCount < 30 || observation.sampleCount > 3_600) issues.push("sample count");
      if (!Number.isFinite(observation.medianCpuPercent) || observation.medianCpuPercent < 0 || observation.medianCpuPercent > 1.5) issues.push("median CPU");
      if (!Number.isFinite(observation.p95CpuPercent) || observation.p95CpuPercent < 0 || observation.p95CpuPercent > 5) issues.push("p95 CPU");
      if (!Number.isFinite(observation.peakResidentMiB) || observation.peakResidentMiB <= 0 || observation.peakResidentMiB > 1_024) issues.push("resident memory");
      if (observation.unexpectedNetworkRequestCount !== 0 || observation.idleRunStartCount !== 0) issues.push("idle side effects");
      break;
    case "thermal-backpressure": {
      const probeIssues = resourcePolicyProbeIssues(observation.resourceProbe, { candidate });
      if (probeIssues.length) issues.push(...probeIssues.map((issue) => `resource probe: ${issue}`));
      if (!evidenceIsValid(observation.resourceProbeEvidence, "resource-policy-probe")) issues.push("resource probe evidence");
      break;
    }
    case "two-version-migration": {
      const before = observation.artifactCountsBefore;
      const after = observation.artifactCountsAfter;
      if (!/^\d+\.\d+\.\d+$/.test(observation.fromVersion || "")) issues.push("source version");
      if (!/^[1-9]\d*$/.test(observation.fromBuild || "") || Number(observation.fromBuild) >= Number(candidate?.build)) issues.push("source build");
      if (!Number.isSafeInteger(observation.schemaVersionBefore) || !Number.isSafeInteger(observation.schemaVersionAfter) || observation.schemaVersionAfter - observation.schemaVersionBefore < 2) issues.push("schema distance");
      if (!countsMatch(before, after)) issues.push("artifact preservation");
      if (!digestIsValid(observation.logicalExportSha256Before) || observation.logicalExportSha256Before !== observation.logicalExportSha256After) issues.push("logical export digest");
      if (!Number.isSafeInteger(observation.migrationRowsApplied) || observation.migrationRowsApplied < 2 || observation.secondLaunchAppliedRows !== 0) issues.push("migration idempotency");
      if (observation.downgradeRefused !== true || observation.downgradeChangedData !== false) issues.push("downgrade refusal");
      break;
    }
    case "offline-local-run":
      if (
        observation.networkBlocked !== true
        || observation.provider !== "mlx"
        || observation.runStatus !== "completed"
        || observation.automaticFallback !== false
        || observation.codelitRequestCount !== 0
        || observation.providerRequestCount !== 0
        || observation.receiptCount !== 1
        || !digestIsValid(observation.resultSha256)
      ) issues.push("offline run boundary");
      break;
    case "checkpoint-recovery":
      if (
        observation.terminationPoint !== "after-checkpoint"
        || !Number.isSafeInteger(observation.checkpointStep)
        || observation.checkpointStep < 1
        || observation.relaunchStatus !== "interrupted"
        || !Number.isSafeInteger(observation.completedActionCountBefore)
        || observation.completedActionCountBefore < 1
        || observation.completedActionCountAfterRelaunch !== observation.completedActionCountBefore
        || observation.automaticRetry !== false
        || observation.resumeStatus !== "completed"
        || observation.duplicateActionCount !== 0
        || observation.receiptCountAfterResume < 1
        || !digestIsValid(observation.finalOutputSha256)
      ) issues.push("checkpoint recovery boundary");
      break;
    default:
      issues.push("unknown check");
  }
  if (!evidenceIsValid(observation?.evidence, observation?.id)) issues.push("evidence");
  return issues;
}

function allEvidence(checks) {
  return checks.flatMap((check) => check.id === "thermal-backpressure"
    ? [check.evidence, check.resourceProbeEvidence]
    : [check.evidence]);
}

export function createDesktopLocalReliabilityObservationDraft() {
  return {
    schemaVersion: 1,
    startedAt: "RECORD_EXACT_UTC",
    completedAt: "RECORD_EXACT_UTC",
    macOSVersion: "RECORD_EXACT_VERSION",
    hardware: { model: "RECORD_MAC_MODEL", memoryGiB: 32, architecture: "arm64" },
    checks: [
      {
        id: "assistive-access",
        keyboardOnlyCompleted: true,
        voiceOverCompleted: true,
        increasedContrastCompleted: true,
        reducedMotionCompleted: true,
        unlabelledControlCount: 0,
        focusOrderIssueCount: 0,
        blockedControlCount: 0,
        evidencePath: "/absolute/path/assistive-access-evidence.zip",
      },
      {
        id: "idle-energy",
        durationSeconds: 300,
        sampleCount: 30,
        medianCpuPercent: 0,
        p95CpuPercent: 0,
        peakResidentMiB: 0,
        unexpectedNetworkRequestCount: 0,
        idleRunStartCount: 0,
        evidencePath: "/absolute/path/idle-energy-evidence.zip",
      },
      {
        id: "thermal-backpressure",
        resourceProbePath: "/absolute/path/resource-policy-probe.json",
        evidencePath: "/absolute/path/thermal-backpressure-evidence.zip",
      },
      {
        id: "two-version-migration",
        fromVersion: "RECORD_PREVIOUS_VERSION",
        fromBuild: "RECORD_PREVIOUS_BUILD",
        schemaVersionBefore: 0,
        schemaVersionAfter: 0,
        artifactCountsBefore: Object.fromEntries(artifactCountKeys.map((key) => [key, 0])),
        artifactCountsAfter: Object.fromEntries(artifactCountKeys.map((key) => [key, 0])),
        logicalExportSha256Before: "RECORD_SHA256",
        logicalExportSha256After: "RECORD_SHA256",
        migrationRowsApplied: 0,
        secondLaunchAppliedRows: 0,
        downgradeRefused: true,
        downgradeChangedData: false,
        evidencePath: "/absolute/path/two-version-migration-evidence.zip",
      },
      {
        id: "offline-local-run",
        networkBlocked: true,
        provider: "mlx",
        runStatus: "completed",
        automaticFallback: false,
        codelitRequestCount: 0,
        providerRequestCount: 0,
        receiptCount: 1,
        resultSha256: "RECORD_SHA256",
        evidencePath: "/absolute/path/offline-local-run-evidence.zip",
      },
      {
        id: "checkpoint-recovery",
        terminationPoint: "after-checkpoint",
        checkpointStep: 1,
        relaunchStatus: "interrupted",
        completedActionCountBefore: 1,
        completedActionCountAfterRelaunch: 1,
        automaticRetry: false,
        resumeStatus: "completed",
        duplicateActionCount: 0,
        receiptCountAfterResume: 1,
        finalOutputSha256: "RECORD_SHA256",
        evidencePath: "/absolute/path/checkpoint-recovery-evidence.zip",
      },
    ],
  };
}

export function readDesktopLocalReliabilityObservations(path) {
  const { value } = boundedJsonFile(path, "Local reliability observations");
  if (value?.schemaVersion !== 1 || !Array.isArray(value?.checks)) {
    throw new Error("The local reliability observations schema is unsupported.");
  }
  return value;
}

export function observationsWithReliabilityEvidence(observations, { candidate }) {
  const shapeIssues = [];
  for (const expected of desktopLocalReliabilityChecks) {
    if (observations.checks.filter((check) => check?.id === expected.id).length !== 1) {
      shapeIssues.push(`The local reliability check ${expected.id} must appear exactly once.`);
    }
  }
  if (observations.checks.some((check) => !desktopLocalReliabilityChecks.some((expected) => expected.id === check?.id))) {
    shapeIssues.push("The local reliability observations contain an unexpected check.");
  }
  if (shapeIssues.length) throw new Error(shapeIssues.join(" "));

  const checks = observations.checks.map((observation) => {
    const { evidencePath, resourceProbePath, ...recorded } = observation;
    const check = {
      ...recorded,
      evidence: localReliabilityEvidenceFile(evidencePath, observation.id),
    };
    if (observation.id === "thermal-backpressure") {
      const resource = readResourcePolicyProbe(resourceProbePath, { candidate });
      check.resourceProbe = resource.probe;
      check.resourceProbeEvidence = resource.evidence;
    }
    return check;
  });
  const issues = [];
  for (const expected of desktopLocalReliabilityChecks) {
    const matches = checks.filter((check) => check.id === expected.id);
    if (matches.length !== 1) issues.push(`The local reliability check ${expected.id} must appear exactly once.`);
    else {
      const fields = observationIssues(matches[0], candidate);
      if (fields.length) issues.push(`The local reliability check ${expected.id} has invalid ${fields.join(", ")}.`);
    }
  }
  if (checks.some((check) => !desktopLocalReliabilityChecks.some((expected) => expected.id === check.id))) {
    issues.push("The local reliability observations contain an unexpected check.");
  }
  if (issues.length) throw new Error(issues.join(" "));
  return checks;
}

export function createDesktopLocalReliabilityReceipt({
  candidate,
  startedAt,
  completedAt,
  macOSVersion,
  hardware,
  checks,
  signedAt,
}) {
  const evidence = allEvidence(checks);
  const receipt = {
    schemaVersion: 1,
    gate: desktopLocalReliabilityGate,
    status: "passed",
    channel: candidate.channel,
    startedAt,
    completedAt,
    durationMs: new Date(completedAt).valueOf() - new Date(startedAt).valueOf(),
    candidate,
    candidateFingerprint: candidateFingerprint(candidate),
    environment: { macOSVersion, ...hardware },
    checks,
    evidenceFingerprint: localReliabilityEvidenceFingerprint(evidence),
    attestation: {
      role: "release-owner",
      statement: desktopLocalReliabilityAttestation,
      signedAt,
    },
  };
  const issues = desktopLocalReliabilityReceiptIssues(receipt, { candidate, checks, evidence });
  if (issues.length) throw new Error(`Local reliability receipt is invalid: ${issues.join(" ")}`);
  return receipt;
}

export function desktopLocalReliabilityReceiptIssues(receipt, { candidate, checks, evidence } = {}) {
  const issues = [];
  if (receipt?.schemaVersion !== 1) issues.push("The local reliability receipt schema is unsupported.");
  if (receipt?.gate !== desktopLocalReliabilityGate) issues.push("The local reliability receipt has the wrong gate.");
  if (receipt?.status !== "passed") issues.push("The local reliability receipt has not passed.");
  issues.push(...releaseCandidateIssues(receipt?.candidate));
  if (receipt?.channel !== receipt?.candidate?.channel) issues.push("The local reliability receipt channel does not match its candidate.");
  if (!isoTimestamp(receipt?.startedAt) || !isoTimestamp(receipt?.completedAt) || receipt.completedAt <= receipt.startedAt) {
    issues.push("The local reliability receipt has invalid UTC timing.");
  }
  const duration = new Date(receipt?.completedAt).valueOf() - new Date(receipt?.startedAt).valueOf();
  if (!Number.isSafeInteger(receipt?.durationMs) || receipt.durationMs !== duration || duration <= 0 || duration > 24 * 60 * 60 * 1_000) {
    issues.push("The local reliability receipt has an invalid duration.");
  }
  if (
    receipt?.environment?.architecture !== "arm64"
    || !/^\d+(?:\.\d+){1,2}$/.test(receipt?.environment?.macOSVersion || "")
    || typeof receipt?.environment?.model !== "string"
    || receipt.environment.model.trim() !== receipt.environment.model
    || receipt.environment.model.length < 2
    || receipt.environment.model.length > 120
    || !Number.isSafeInteger(receipt?.environment?.memoryGiB)
    || receipt.environment.memoryGiB < 8
    || receipt.environment.memoryGiB > 512
  ) issues.push("The local reliability receipt has invalid environment metadata.");
  if (receipt?.candidateFingerprint !== candidateFingerprint(receipt?.candidate || null)) {
    issues.push("The local reliability candidate fingerprint is invalid.");
  }
  if (candidate && !sameCandidate(receipt?.candidate, candidate)) {
    issues.push("The local reliability receipt belongs to different signed artifacts.");
  }
  const recordedChecks = Array.isArray(receipt?.checks) ? receipt.checks : [];
  for (const expected of desktopLocalReliabilityChecks) {
    const matches = recordedChecks.filter((check) => check?.id === expected.id);
    if (matches.length !== 1) {
      issues.push(`The local reliability check ${expected.id} must appear exactly once.`);
      continue;
    }
    const fields = observationIssues(matches[0], receipt?.candidate);
    if (fields.length) issues.push(`The local reliability check ${expected.id} has invalid ${fields.join(", ")}.`);
  }
  if (recordedChecks.some((check) => !desktopLocalReliabilityChecks.some((expected) => expected.id === check?.id))) {
    issues.push("The local reliability receipt contains an unexpected check.");
  }
  const recordedEvidence = allEvidence(recordedChecks);
  const digests = recordedEvidence.map((entry) => entry?.sha256);
  if (new Set(digests).size !== recordedEvidence.length) issues.push("Each local reliability proof must use distinct evidence.");
  if (receipt?.evidenceFingerprint !== localReliabilityEvidenceFingerprint(recordedEvidence)) {
    issues.push("The local reliability evidence fingerprint is invalid.");
  }
  if (evidence && !sameValue(recordedEvidence, evidence)) {
    issues.push("The local reliability receipt does not match the supplied proof files.");
  }
  if (checks && !sameValue(recordedChecks, checks)) {
    issues.push("The local reliability receipt does not match the supplied observations.");
  }
  const attestation = receipt?.attestation;
  if (
    attestation?.role !== "release-owner"
    || attestation?.statement !== desktopLocalReliabilityAttestation
    || !isoTimestamp(attestation?.signedAt)
    || attestation.signedAt < receipt.completedAt
  ) issues.push("The local reliability receipt is missing its release-owner attestation.");
  return [...new Set(issues)];
}

export function readDesktopLocalReliabilityReceipt(path) {
  return boundedJsonFile(path, "Local reliability receipt", 512 * 1024).value;
}
