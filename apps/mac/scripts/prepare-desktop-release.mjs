import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createReleaseDirectory,
  currentSourceState,
  readReleaseVersion,
  verifyAppleDirectArtifacts,
  verifyUpdaterSignature,
} from "./desktop-release-provenance.mjs";
import {
  candidateQaReceiptIssues,
  inspectDesktopCandidate,
  readCandidateQaReceipt,
} from "./desktop-candidate-qa.mjs";
import {
  desktopP1JourneyReceiptIssues,
  readDesktopP1JourneyReceipt,
} from "./desktop-p1-journey.mjs";
import {
  desktopComputerLifecycleReceiptIssues,
  readDesktopComputerLifecycleReceipt,
} from "./desktop-computer-lifecycle.mjs";
import {
  desktopLocalReliabilityReceiptIssues,
  readDesktopLocalReliabilityReceipt,
} from "./desktop-local-reliability.mjs";
import { repositoryRoot } from "./release-support.mjs";

function parseArguments(arguments_) {
  const values = new Map();
  const flags = new Set();
  const valueOptions = new Set([
    "--artifact", "--signature", "--dmg", "--notes-file", "--qa-receipt",
    "--p1-receipt", "--computer-lifecycle-receipt", "--reliability-receipt", "--output",
    "--published-at", "--previous-manifest", "--rollback-of", "--rollback-commit",
  ]);
  const flagOptions = new Set(["--initial-release"]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (valueOptions.has(argument)) {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      values.set(argument, value);
      index += 1;
    } else if (flagOptions.has(argument)) {
      flags.add(argument);
    } else {
      throw new Error(`Unknown release option ${argument}.`);
    }
  }
  for (const required of [
    "--artifact",
    "--signature",
    "--dmg",
    "--notes-file",
    "--qa-receipt",
    "--p1-receipt",
    "--computer-lifecycle-receipt",
    "--reliability-receipt",
  ]) {
    if (!values.has(required)) throw new Error(`${required} is required.`);
  }
  if (flags.has("--initial-release") === values.has("--previous-manifest")) {
    throw new Error("Choose exactly one of --initial-release or --previous-manifest.");
  }
  if (values.has("--rollback-of") !== values.has("--rollback-commit")) {
    throw new Error("--rollback-of and --rollback-commit must be provided together.");
  }
  if (values.has("--rollback-of") && flags.has("--initial-release")) {
    throw new Error("The initial release cannot be a rollback.");
  }
  return { values, flags };
}

function requiredFile(path, label) {
  const absolute = resolve(repositoryRoot, path);
  if (!existsSync(absolute)) throw new Error(`${label} was not found at ${absolute}.`);
  return absolute;
}

export function prepareDesktopRelease(arguments_, environment = process.env) {
  const { values, flags } = parseArguments(arguments_);
  const source = currentSourceState();
  if (source.dirty) throw new Error("Commit every source change before creating immutable release provenance.");
  const artifact = requiredFile(values.get("--artifact"), "Updater archive");
  const signature = requiredFile(values.get("--signature"), "Updater signature");
  const dmg = requiredFile(values.get("--dmg"), "Direct DMG");
  const notesFile = requiredFile(values.get("--notes-file"), "Release notes");
  const qaReceiptPath = requiredFile(values.get("--qa-receipt"), "Signed-candidate QA receipt");
  const p1ReceiptPath = requiredFile(values.get("--p1-receipt"), "P1 journey receipt");
  const computerLifecycleReceiptPath = requiredFile(
    values.get("--computer-lifecycle-receipt"),
    "Computer lifecycle receipt",
  );
  const reliabilityReceiptPath = requiredFile(values.get("--reliability-receipt"), "Local reliability receipt");
  const previousManifestPath = values.has("--previous-manifest")
    ? requiredFile(values.get("--previous-manifest"), "Previous manifest")
    : undefined;
  const rustPath = `/opt/homebrew/opt/rustup/bin:${environment.PATH || ""}`;
  const releaseEnvironment = {
    ...environment,
    PATH: rustPath,
    DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
  };
  verifyUpdaterSignature(artifact, signature, releaseEnvironment);
  const version = readReleaseVersion();
  verifyAppleDirectArtifacts(artifact, dmg, version, source.commit);
  const candidate = inspectDesktopCandidate({ channel: "direct", archivePath: artifact, dmgPath: dmg });
  const qaReceipt = readCandidateQaReceipt(qaReceiptPath);
  const qaIssues = candidateQaReceiptIssues(qaReceipt, { candidate });
  if (qaIssues.length) throw new Error(`Signed-candidate QA failed: ${qaIssues.join(" ")}`);
  const qualificationReceipts = [
    {
      label: "P1 journey",
      receipt: readDesktopP1JourneyReceipt(p1ReceiptPath),
      issues: desktopP1JourneyReceiptIssues,
    },
    {
      label: "Computer lifecycle",
      receipt: readDesktopComputerLifecycleReceipt(computerLifecycleReceiptPath),
      issues: desktopComputerLifecycleReceiptIssues,
    },
    {
      label: "Local reliability",
      receipt: readDesktopLocalReliabilityReceipt(reliabilityReceiptPath),
      issues: desktopLocalReliabilityReceiptIssues,
    },
  ];
  for (const qualification of qualificationReceipts) {
    const issues = qualification.issues(qualification.receipt, { candidate });
    if (issues.length) throw new Error(`${qualification.label} qualification failed: ${issues.join(" ")}`);
  }
  const output = resolve(repositoryRoot, values.get("--output") || `artifacts/mac/v${version}`);
  return createReleaseDirectory({
    output,
    archivePath: artifact,
    signaturePath: signature,
    dmgPath: dmg,
    qaReceiptPath,
    p1ReceiptPath,
    computerLifecycleReceiptPath,
    reliabilityReceiptPath,
    notes: readFileSync(notesFile, "utf8"),
    timestamp: values.get("--published-at") || new Date().toISOString(),
    commit: source.commit,
    previousManifestPath,
    initialRelease: flags.has("--initial-release"),
    rollback: values.has("--rollback-of") ? {
      restoresVersion: values.get("--rollback-of"),
      restoresCommit: values.get("--rollback-commit"),
    } : null,
    environment: releaseEnvironment,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = prepareDesktopRelease(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
