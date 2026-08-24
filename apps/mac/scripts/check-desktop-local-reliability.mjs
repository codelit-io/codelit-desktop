import { inspectDesktopCandidate } from "./desktop-candidate-qa.mjs";
import {
  desktopLocalReliabilityReceiptIssues,
  observationsWithReliabilityEvidence,
  readDesktopLocalReliabilityObservations,
  readDesktopLocalReliabilityReceipt,
} from "./desktop-local-reliability.mjs";

function parseArguments(arguments_) {
  const values = new Map();
  const known = new Set(["--channel", "--artifact", "--dmg", "--package", "--observations", "--receipt"]);
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!known.has(name) || !value || value.startsWith("--") || values.has(name)) {
      throw new Error(`Unknown or incomplete local reliability option ${name || "<empty>"}.`);
    }
    values.set(name, value);
  }
  const channel = values.get("--channel");
  if (!["direct", "app-store"].includes(channel)) throw new Error("Use --channel direct or --channel app-store.");
  for (const required of ["--observations", "--receipt"]) {
    if (!values.has(required)) throw new Error(`${required} is required.`);
  }
  if (channel === "direct" && (!values.has("--artifact") || !values.has("--dmg") || values.has("--package"))) {
    throw new Error("Direct reliability checking requires --artifact and --dmg only.");
  }
  if (channel === "app-store" && (!values.has("--package") || values.has("--artifact") || values.has("--dmg"))) {
    throw new Error("App Store reliability checking requires --package only.");
  }
  return values;
}

const values = parseArguments(process.argv.slice(2));
const channel = values.get("--channel");
const candidate = inspectDesktopCandidate({
  channel,
  ...(channel === "direct"
    ? { archivePath: values.get("--artifact"), dmgPath: values.get("--dmg") }
    : { packagePath: values.get("--package") }),
});
const observations = readDesktopLocalReliabilityObservations(values.get("--observations"));
const checks = observationsWithReliabilityEvidence(observations, { candidate });
const evidence = checks.flatMap((check) => check.id === "thermal-backpressure"
  ? [check.evidence, check.resourceProbeEvidence]
  : [check.evidence]);
const receipt = readDesktopLocalReliabilityReceipt(values.get("--receipt"));
const issues = desktopLocalReliabilityReceiptIssues(receipt, { candidate, checks, evidence });
process.stdout.write(`${JSON.stringify({
  status: issues.length ? "blocked" : "passed",
  gate: receipt.gate,
  candidateFingerprint: receipt.candidateFingerprint,
  issues,
}, null, 2)}\n`);
if (issues.length) process.exitCode = 1;
