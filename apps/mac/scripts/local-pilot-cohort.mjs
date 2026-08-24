import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export const localPilotJobCategories = ["website", "repository", "research", "file-management"];
export const localPilotReportExcludedFields = [
  "prompt text",
  "browser content and URLs",
  "file names and contents",
  "screenshots",
  "memories",
  "credentials",
  "provider responses and model output",
  "local database rows",
];
export const localPilotCohortPolicy = Object.freeze({
  minimumParticipants: 25,
  maximumParticipants: 250,
  minimumFirstRunCompletionRate: 0.7,
  maximumMedianFirstUsefulResultSeconds: 300,
  minimumRepeatTaskWithinSevenDaysRate: 0.3,
  minimumRoutineCreationRate: 0.2,
});

const REPORT_LIMIT_BYTES = 64 * 1024;
const MANIFEST_LIMIT_BYTES = 128 * 1024;
const COUNT_LIMIT = 1_000_000_000;
const DURATION_LIMIT_SECONDS = 10 * 365 * 24 * 60 * 60;
const reportIdPattern = /^(?:report|participant)-[a-f0-9]{32}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const versionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label, issues) {
  if (!isRecord(value)) {
    issues.push(`${label} must be an object.`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    issues.push(`${label} contains missing or unsupported fields.`);
    return false;
  }
  return true;
}

function validTimestamp(value) {
  return typeof value === "string"
    && timestampPattern.test(value)
    && Number.isFinite(Date.parse(value));
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= COUNT_LIMIT;
}

function addCountIssue(value, label, issues) {
  if (!validCount(value)) issues.push(`${label} must be a bounded non-negative integer.`);
}

function addBooleanIssue(value, label, issues) {
  if (typeof value !== "boolean") issues.push(`${label} must be a boolean.`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableDigest(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

function uniqueIssues(issues) {
  return [...new Set(issues)];
}

export function localPilotReportIssues(report) {
  const issues = [];
  if (!exactKeys(report, [
    "schemaVersion",
    "kind",
    "reportId",
    "participantId",
    "generatedAt",
    "app",
    "measurementWindow",
    "privacy",
    "activation",
    "runs",
    "delegations",
    "routines",
    "approvals",
    "unexpectedActions",
  ], "The local pilot report", issues)) return issues;

  if (report.schemaVersion !== 2) issues.push("The local pilot report schema is unsupported.");
  if (report.kind !== "codelit-local-pilot-report") issues.push("The local pilot report kind is unsupported.");
  if (typeof report.reportId !== "string" || !reportIdPattern.test(report.reportId) || !report.reportId.startsWith("report-")) {
    issues.push("The local pilot report identifier is invalid.");
  }
  if (typeof report.participantId !== "string" || !reportIdPattern.test(report.participantId) || !report.participantId.startsWith("participant-")) {
    issues.push("The local pilot participant identifier is invalid.");
  }
  if (!validTimestamp(report.generatedAt)) issues.push("The local pilot report generation time is invalid.");

  if (exactKeys(report.app, ["version", "buildChannel", "sourceCommit", "sourceDirty"], "The local pilot app identity", issues)) {
    if (typeof report.app.version !== "string" || !versionPattern.test(report.app.version)) {
      issues.push("The local pilot app version is invalid.");
    }
    if (!['development', 'direct', 'app-store'].includes(report.app.buildChannel)) {
      issues.push("The local pilot build channel is invalid.");
    }
    if (typeof report.app.sourceCommit !== "string" || !commitPattern.test(report.app.sourceCommit)) {
      issues.push("The local pilot source commit is invalid.");
    }
    addBooleanIssue(report.app.sourceDirty, "The local pilot source state", issues);
  }

  if (exactKeys(report.measurementWindow, ["startedAt", "endedAt"], "The local pilot measurement window", issues)) {
    if (!validTimestamp(report.measurementWindow.startedAt) || !validTimestamp(report.measurementWindow.endedAt)) {
      issues.push("The local pilot measurement window contains an invalid time.");
    } else if (Date.parse(report.measurementWindow.startedAt) > Date.parse(report.measurementWindow.endedAt)) {
      issues.push("The local pilot measurement window ends before it starts.");
    }
    if (report.measurementWindow.endedAt !== report.generatedAt) {
      issues.push("The local pilot measurement window is not bound to report generation.");
    }
  }

  if (exactKeys(report.privacy, ["localOnly", "automaticUpload", "excluded"], "The local pilot privacy boundary", issues)) {
    if (report.privacy.localOnly !== true || report.privacy.automaticUpload !== false) {
      issues.push("The local pilot privacy boundary permits non-local collection.");
    }
    if (
      !Array.isArray(report.privacy.excluded)
      || report.privacy.excluded.length !== localPilotReportExcludedFields.length
      || report.privacy.excluded.some((value, index) => value !== localPilotReportExcludedFields[index])
    ) {
      issues.push("The local pilot privacy exclusions are incomplete or changed.");
    }
  }

  if (exactKeys(report.activation, [
    "customBotCreated",
    "firstRunAttempted",
    "firstRunCompleted",
    "firstUsefulResultCompleted",
    "secondsToFirstUsefulResult",
  ], "The local pilot activation metrics", issues)) {
    for (const key of ["customBotCreated", "firstRunAttempted", "firstRunCompleted", "firstUsefulResultCompleted"]) {
      addBooleanIssue(report.activation[key], `The local pilot activation metric ${key}`, issues);
    }
    const seconds = report.activation.secondsToFirstUsefulResult;
    if (seconds !== null && (!validCount(seconds) || seconds > DURATION_LIMIT_SECONDS)) {
      issues.push("The local pilot time to first useful result is invalid.");
    }
    if (report.activation.firstRunCompleted && !report.activation.firstRunAttempted) {
      issues.push("The local pilot report claims a completed first run without an attempt.");
    }
    if (report.activation.firstUsefulResultCompleted !== (seconds !== null)) {
      issues.push("The local pilot useful-result state and duration disagree.");
    }
  }

  if (exactKeys(report.runs, [
    "started",
    "completed",
    "failed",
    "canceled",
    "activeDays",
    "repeatTaskWithinSevenDays",
  ], "The local pilot run metrics", issues)) {
    for (const key of ["started", "completed", "failed", "canceled", "activeDays"]) {
      addCountIssue(report.runs[key], `The local pilot run metric ${key}`, issues);
    }
    addBooleanIssue(report.runs.repeatTaskWithinSevenDays, "The local pilot repeat-task metric", issues);
    if (
      validCount(report.runs.started)
      && validCount(report.runs.completed)
      && validCount(report.runs.failed)
      && validCount(report.runs.canceled)
      && report.runs.completed + report.runs.failed + report.runs.canceled > report.runs.started
    ) issues.push("The local pilot terminal run counts exceed started runs.");
    if (validCount(report.runs.activeDays) && validCount(report.runs.started) && report.runs.activeDays > report.runs.started) {
      issues.push("The local pilot active-day count exceeds started runs.");
    }
    if (report.runs.repeatTaskWithinSevenDays && report.runs.started < 2) {
      issues.push("The local pilot report claims repeat use without two runs.");
    }
  }

  if (exactKeys(report.delegations, ["started", "completed", "repeated"], "The local pilot delegation metrics", issues)) {
    addCountIssue(report.delegations.started, "The local pilot delegation start count", issues);
    addCountIssue(report.delegations.completed, "The local pilot delegation completion count", issues);
    addBooleanIssue(report.delegations.repeated, "The local pilot repeat-delegation metric", issues);
    if (validCount(report.delegations.started) && validCount(report.delegations.completed)
      && report.delegations.completed > report.delegations.started) {
      issues.push("The local pilot completed delegations exceed started delegations.");
    }
    if (report.delegations.repeated && report.delegations.started < 2) {
      issues.push("The local pilot report claims repeated delegation without two handoffs.");
    }
  }

  if (exactKeys(report.routines, ["created", "enabled", "occurrences", "completedOccurrences", "reused"], "The local pilot routine metrics", issues)) {
    for (const key of ["created", "enabled", "occurrences", "completedOccurrences"]) {
      addCountIssue(report.routines[key], `The local pilot routine metric ${key}`, issues);
    }
    addBooleanIssue(report.routines.reused, "The local pilot routine reuse metric", issues);
    if (validCount(report.routines.created) && validCount(report.routines.enabled) && report.routines.enabled > report.routines.created) {
      issues.push("The local pilot enabled routines exceed created routines.");
    }
    if (validCount(report.routines.occurrences) && validCount(report.routines.completedOccurrences)
      && report.routines.completedOccurrences > report.routines.occurrences) {
      issues.push("The local pilot completed routine occurrences exceed all occurrences.");
    }
    if (report.routines.reused && report.routines.completedOccurrences < 2) {
      issues.push("The local pilot report claims routine reuse without two completed occurrences.");
    }
  }

  if (exactKeys(report.approvals, ["requested", "awaiting", "resolved", "approved", "heldOrDenied"], "The local pilot approval metrics", issues)) {
    for (const key of ["requested", "awaiting", "resolved", "approved", "heldOrDenied"]) {
      addCountIssue(report.approvals[key], `The local pilot approval metric ${key}`, issues);
    }
    if (
      validCount(report.approvals.requested)
      && validCount(report.approvals.awaiting)
      && validCount(report.approvals.resolved)
      && report.approvals.awaiting + report.approvals.resolved !== report.approvals.requested
    ) issues.push("The local pilot approval states do not sum to requested approvals.");
    if (
      validCount(report.approvals.approved)
      && validCount(report.approvals.heldOrDenied)
      && validCount(report.approvals.resolved)
      && report.approvals.approved + report.approvals.heldOrDenied > report.approvals.resolved
    ) issues.push("The local pilot approval outcomes exceed resolved approvals.");
  }

  if (exactKeys(report.unexpectedActions, ["total", "categories"], "The local pilot unexpected-action metrics", issues)) {
    addCountIssue(report.unexpectedActions.total, "The local pilot unexpected-action total", issues);
    if (!Array.isArray(report.unexpectedActions.categories) || report.unexpectedActions.categories.length > 4) {
      issues.push("The local pilot unexpected-action categories are invalid.");
    } else {
      const seen = new Set();
      let total = 0;
      let previous = "";
      for (const item of report.unexpectedActions.categories) {
        if (!exactKeys(item, ["category", "count"], "A local pilot unexpected-action category", issues)) continue;
        if (!['unexpected-action', 'unapproved-write', 'sensitive-data', 'other'].includes(item.category)) {
          issues.push("A local pilot unexpected-action category is unsupported.");
        }
        if (seen.has(item.category) || (previous && item.category < previous)) {
          issues.push("The local pilot unexpected-action categories are duplicated or unsorted.");
        }
        seen.add(item.category);
        previous = item.category;
        addCountIssue(item.count, "A local pilot unexpected-action count", issues);
        if (validCount(item.count)) total += item.count;
      }
      if (validCount(report.unexpectedActions.total) && total !== report.unexpectedActions.total) {
        issues.push("The local pilot unexpected-action categories do not sum to the total.");
      }
    }
  }

  if (isRecord(report.activation) && isRecord(report.runs)) {
    if (report.activation.firstRunAttempted !== (report.runs.started > 0)) {
      issues.push("The local pilot first-run state disagrees with started runs.");
    }
    if (report.activation.firstRunCompleted && report.runs.completed < 1) {
      issues.push("The local pilot first-run completion disagrees with completed runs.");
    }
    if (report.activation.firstUsefulResultCompleted !== (report.runs.completed > 0)) {
      issues.push("The local pilot useful-result state disagrees with completed runs.");
    }
  }
  return uniqueIssues(issues);
}

export function localPilotManifestIssues(manifest) {
  const issues = [];
  if (!exactKeys(manifest, ["schemaVersion", "kind", "cohortId", "expectedApp", "participants"], "The local pilot cohort manifest", issues)) return issues;
  if (manifest.schemaVersion !== 1) issues.push("The local pilot cohort manifest schema is unsupported.");
  if (manifest.kind !== "codelit-local-pilot-cohort-manifest") issues.push("The local pilot cohort manifest kind is unsupported.");
  if (typeof manifest.cohortId !== "string" || !/^pilot-[a-z0-9][a-z0-9-]{2,63}$/.test(manifest.cohortId)) {
    issues.push("The local pilot cohort identifier is invalid.");
  }
  if (exactKeys(manifest.expectedApp, ["version", "buildChannel", "sourceCommit"], "The local pilot expected app identity", issues)) {
    if (typeof manifest.expectedApp.version !== "string" || !versionPattern.test(manifest.expectedApp.version)) {
      issues.push("The local pilot expected app version is invalid.");
    }
    if (!['direct', 'app-store'].includes(manifest.expectedApp.buildChannel)) {
      issues.push("The local pilot expected build channel must be Direct or App Store.");
    }
    if (typeof manifest.expectedApp.sourceCommit !== "string" || !commitPattern.test(manifest.expectedApp.sourceCommit)) {
      issues.push("The local pilot expected source commit is invalid.");
    }
  }
  if (!Array.isArray(manifest.participants) || !manifest.participants.length
    || manifest.participants.length > localPilotCohortPolicy.maximumParticipants) {
    issues.push("The local pilot cohort participant list is empty or too large.");
    return uniqueIssues(issues);
  }
  const participantIds = new Set();
  for (const participant of manifest.participants) {
    if (!exactKeys(participant, ["participantId", "consentConfirmed", "jobCategories"], "A local pilot participant assignment", issues)) continue;
    if (typeof participant.participantId !== "string"
      || !reportIdPattern.test(participant.participantId)
      || !participant.participantId.startsWith("participant-")) {
      issues.push("A local pilot participant identifier is invalid.");
    } else if (participantIds.has(participant.participantId)) {
      issues.push("The local pilot cohort contains a duplicate participant identifier.");
    }
    participantIds.add(participant.participantId);
    addBooleanIssue(participant.consentConfirmed, "A local pilot consent confirmation", issues);
    if (!Array.isArray(participant.jobCategories) || !participant.jobCategories.length) {
      issues.push("A local pilot participant is missing a job category.");
    } else if (
      new Set(participant.jobCategories).size !== participant.jobCategories.length
      || participant.jobCategories.some((category) => !localPilotJobCategories.includes(category))
    ) {
      issues.push("A local pilot participant has duplicate or unsupported job categories.");
    }
  }
  return uniqueIssues(issues);
}

function readBoundedJson(path, maximumBytes, label) {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`${label} must be a regular file, not a link.`);
  if (!stats.size || stats.size > maximumBytes) throw new Error(`${label} exceeds its bounded file size.`);
  const bytes = readFileSync(path);
  try {
    return { value: JSON.parse(bytes.toString("utf8")), digest: sha256(bytes) };
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

export function readLocalPilotCohortManifest(path) {
  const { value, digest } = readBoundedJson(resolve(path), MANIFEST_LIMIT_BYTES, "The local pilot cohort manifest");
  return { manifest: value, digest, issues: localPilotManifestIssues(value) };
}

export function readLocalPilotReports(directory) {
  const root = resolve(directory);
  const rootStats = lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error("The local pilot reports path must be a directory, not a link.");
  }
  const files = readdirSync(root)
    .filter((name) => name.toLowerCase().endsWith(".json"))
    .sort();
  if (files.length > localPilotCohortPolicy.maximumParticipants * 4) {
    throw new Error("The local pilot reports directory contains too many JSON files.");
  }
  const entries = [];
  const issues = [];
  for (const [index, name] of files.entries()) {
    const input = `input-${String(index + 1).padStart(3, "0")}`;
    try {
      const { value, digest } = readBoundedJson(resolve(root, name), REPORT_LIMIT_BYTES, `Local pilot ${input}`);
      const reportIssues = localPilotReportIssues(value);
      if (reportIssues.length) {
        issues.push(...reportIssues.map((issue) => `${input}: ${issue}`));
      } else {
        entries.push({ input, digest, report: value });
      }
    } catch (error) {
      issues.push(`${input}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { files: files.length, entries, issues: uniqueIssues(issues) };
}

function ratio(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(4)) : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(1));
}

function countTrue(reports, read) {
  return reports.reduce((count, report) => count + (read(report) ? 1 : 0), 0);
}

function sum(reports, read) {
  return reports.reduce((total, report) => total + read(report), 0);
}

function gate(id, passed, observed, target) {
  return { id, status: passed ? "passed" : "blocked", observed, target };
}

function normalizedReportEntries(reports) {
  return reports.map((entry, index) => {
    const report = entry?.report || entry;
    return {
      input: entry?.input || `input-${String(index + 1).padStart(3, "0")}`,
      digest: entry?.digest || stableDigest(report),
      report,
    };
  });
}

export function buildLocalPilotCohortReceipt({ manifest, reports, inputIssues = [], manifestDigest = null, reportFiles = null }) {
  const issues = [...inputIssues, ...localPilotManifestIssues(manifest)];
  const validEntries = [];
  if (!Array.isArray(reports)) issues.push("The local pilot report input must be an array.");
  for (const entry of normalizedReportEntries(Array.isArray(reports) ? reports : [])) {
    const reportIssues = localPilotReportIssues(entry.report);
    if (reportIssues.length) issues.push(...reportIssues.map((issue) => `${entry.input}: ${issue}`));
    else validEntries.push(entry);
  }

  const byParticipant = new Map();
  for (const entry of validEntries) {
    const existing = byParticipant.get(entry.report.participantId) || [];
    existing.push(entry);
    byParticipant.set(entry.report.participantId, existing);
  }
  const selected = [];
  let duplicateExports = 0;
  for (const entries of byParticipant.values()) {
    entries.sort((left, right) => (
      Date.parse(right.report.generatedAt) - Date.parse(left.report.generatedAt)
      || (left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0)
    ));
    selected.push(entries[0]);
    duplicateExports += Math.max(0, entries.length - 1);
  }

  const assignments = new Map(
    Array.isArray(manifest?.participants)
      ? manifest.participants
        .filter((participant) => isRecord(participant) && typeof participant.participantId === "string")
        .map((participant) => [participant.participantId, participant])
      : [],
  );
  const unexpectedParticipants = selected.filter((entry) => !assignments.has(entry.report.participantId)).length;
  const missingParticipants = [...assignments.keys()].filter((participantId) => !byParticipant.has(participantId)).length;
  if (unexpectedParticipants) issues.push(`${unexpectedParticipants} valid report(s) do not have a cohort assignment.`);
  if (missingParticipants) issues.push(`${missingParticipants} cohort participant(s) do not have a valid report.`);

  const matched = selected.filter((entry) => assignments.has(entry.report.participantId));
  const participantCount = matched.length;
  const cohortReports = matched.map((entry) => entry.report);
  const consentedParticipants = matched.filter((entry) => assignments.get(entry.report.participantId)?.consentConfirmed === true).length;
  const coverage = Object.fromEntries(localPilotJobCategories.map((category) => [
    category,
    matched.filter((entry) => assignments.get(entry.report.participantId)?.jobCategories?.includes(category)).length,
  ]));
  const expectedApp = isRecord(manifest?.expectedApp)
    && versionPattern.test(manifest.expectedApp.version || "")
    && ['direct', 'app-store'].includes(manifest.expectedApp.buildChannel)
    && commitPattern.test(manifest.expectedApp.sourceCommit || "")
    ? {
        version: manifest.expectedApp.version,
        buildChannel: manifest.expectedApp.buildChannel,
        sourceCommit: manifest.expectedApp.sourceCommit,
      }
    : null;
  const exactCandidateReports = expectedApp ? cohortReports.filter((report) => (
    report.app.version === expectedApp.version
    && report.app.buildChannel === expectedApp.buildChannel
    && report.app.sourceCommit === expectedApp.sourceCommit
    && report.app.sourceDirty === false
  )).length : 0;

  const firstRunAttempted = countTrue(cohortReports, (report) => report.activation.firstRunAttempted);
  const firstRunCompleted = countTrue(cohortReports, (report) => report.activation.firstRunCompleted);
  const firstUsefulResultCompleted = countTrue(cohortReports, (report) => report.activation.firstUsefulResultCompleted);
  const repeatTaskWithinSevenDays = countTrue(cohortReports, (report) => report.runs.repeatTaskWithinSevenDays);
  const routineCreatedParticipants = countTrue(cohortReports, (report) => report.routines.created > 0);
  const routineReusedParticipants = countTrue(cohortReports, (report) => report.routines.reused);
  const firstResultSeconds = cohortReports
    .map((report) => report.activation.secondsToFirstUsefulResult)
    .filter((value) => value !== null);
  const unexpectedCounts = Object.fromEntries(
    ["unexpected-action", "unapproved-write", "sensitive-data", "other"].map((category) => [
      category,
      sum(cohortReports, (report) => report.unexpectedActions.categories.find((item) => item.category === category)?.count || 0),
    ]),
  );
  const unexpectedTotal = Object.values(unexpectedCounts).reduce((total, count) => total + count, 0);
  const firstRunCompletionRate = ratio(firstRunCompleted, participantCount);
  const repeatTaskRate = ratio(repeatTaskWithinSevenDays, firstUsefulResultCompleted);
  const routineCreationRate = ratio(routineCreatedParticipants, participantCount);
  const medianFirstResult = median(firstResultSeconds);
  const normalizedIssues = uniqueIssues(issues);
  const schemaClean = normalizedIssues.length === 0;

  const gates = [
    gate("input-integrity", schemaClean, normalizedIssues.length, 0),
    gate("cohort-size", participantCount >= localPilotCohortPolicy.minimumParticipants, participantCount, localPilotCohortPolicy.minimumParticipants),
    gate("explicit-consent", consentedParticipants === participantCount && participantCount > 0, consentedParticipants, participantCount),
    gate("exact-clean-candidate", exactCandidateReports === participantCount && participantCount > 0, exactCandidateReports, participantCount),
    gate("job-coverage", localPilotJobCategories.every((category) => coverage[category] > 0), coverage, "at least one participant per category"),
    gate("first-run-completion", firstRunCompletionRate !== null && firstRunCompletionRate >= localPilotCohortPolicy.minimumFirstRunCompletionRate, firstRunCompletionRate, localPilotCohortPolicy.minimumFirstRunCompletionRate),
    gate("time-to-first-result", medianFirstResult !== null && medianFirstResult < localPilotCohortPolicy.maximumMedianFirstUsefulResultSeconds, medianFirstResult, `< ${localPilotCohortPolicy.maximumMedianFirstUsefulResultSeconds} seconds`),
    gate("seven-day-repeat-task", repeatTaskRate !== null && repeatTaskRate >= localPilotCohortPolicy.minimumRepeatTaskWithinSevenDaysRate, repeatTaskRate, localPilotCohortPolicy.minimumRepeatTaskWithinSevenDaysRate),
    gate("routine-creation", routineCreationRate !== null && routineCreationRate >= localPilotCohortPolicy.minimumRoutineCreationRate, routineCreationRate, localPilotCohortPolicy.minimumRoutineCreationRate),
    gate("unexpected-action-review", unexpectedTotal === 0, unexpectedTotal, 0),
    gate("unapproved-write-safety", unexpectedCounts["unapproved-write"] === 0, unexpectedCounts["unapproved-write"], 0),
    gate("sensitive-data-safety", unexpectedCounts["sensitive-data"] === 0, unexpectedCounts["sensitive-data"], 0),
  ];
  const status = gates.every((item) => item.status === "passed") ? "measurement-ready" : "blocked";
  const reportDigests = matched.map((entry) => entry.digest).sort();
  const evaluatedThrough = cohortReports.length
    ? cohortReports.map((report) => report.generatedAt).sort().at(-1)
    : null;

  return {
    schemaVersion: 1,
    kind: "codelit-local-pilot-cohort-receipt",
    cohortId: typeof manifest?.cohortId === "string" ? manifest.cohortId : "invalid-cohort",
    status,
    publicationDecision: "not-made",
    evaluatedThrough,
    expectedApp,
    inputs: {
      reportFiles: reportFiles ?? cohortReports.length,
      structurallyValidReports: validEntries.length,
      uniqueParticipants: participantCount,
      duplicateExports,
      manifestDigest,
      reportSetDigest: sha256(Buffer.from(reportDigests.join("\n"))),
    },
    privacy: {
      automaticUpload: false,
      containsParticipantIdentity: false,
      containsUserContent: false,
      participantIdentifiers: "pseudonymous and omitted from this receipt",
    },
    coverage,
    metrics: {
      activation: {
        customBotCreatedParticipants: countTrue(cohortReports, (report) => report.activation.customBotCreated),
        firstRunAttemptedParticipants: firstRunAttempted,
        firstRunCompletedParticipants: firstRunCompleted,
        firstUsefulResultParticipants: firstUsefulResultCompleted,
        firstRunCompletionRate,
        medianSecondsToFirstUsefulResult: medianFirstResult,
      },
      runs: {
        started: sum(cohortReports, (report) => report.runs.started),
        completed: sum(cohortReports, (report) => report.runs.completed),
        failed: sum(cohortReports, (report) => report.runs.failed),
        canceled: sum(cohortReports, (report) => report.runs.canceled),
        repeatTaskWithinSevenDaysParticipants: repeatTaskWithinSevenDays,
        repeatTaskWithinSevenDaysRate: repeatTaskRate,
      },
      delegations: {
        started: sum(cohortReports, (report) => report.delegations.started),
        completed: sum(cohortReports, (report) => report.delegations.completed),
        participantsWithDelegation: countTrue(cohortReports, (report) => report.delegations.started > 0),
        participantsWithRepeatedDelegation: countTrue(cohortReports, (report) => report.delegations.repeated),
      },
      routines: {
        created: sum(cohortReports, (report) => report.routines.created),
        completedOccurrences: sum(cohortReports, (report) => report.routines.completedOccurrences),
        participantsWithRoutine: routineCreatedParticipants,
        routineCreationRate,
        participantsWithReusedRoutine: routineReusedParticipants,
      },
      approvals: {
        requested: sum(cohortReports, (report) => report.approvals.requested),
        resolved: sum(cohortReports, (report) => report.approvals.resolved),
        approved: sum(cohortReports, (report) => report.approvals.approved),
        heldOrDenied: sum(cohortReports, (report) => report.approvals.heldOrDenied),
      },
      unexpectedActions: { total: unexpectedTotal, categories: unexpectedCounts },
    },
    gates,
    issues: normalizedIssues,
  };
}

export function parseLocalPilotCohortArguments(arguments_) {
  const known = new Set(["--reports", "--manifest", "--output"]);
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!known.has(name) || !value || value.startsWith("--") || values.has(name)) {
      throw new Error(`Unknown or incomplete local pilot cohort option ${name || "<empty>"}.`);
    }
    values.set(name, value);
  }
  for (const required of ["--reports", "--manifest"]) {
    if (!values.has(required)) throw new Error(`${required} is required.`);
  }
  return {
    reports: values.get("--reports"),
    manifest: values.get("--manifest"),
    output: values.get("--output") || null,
  };
}
