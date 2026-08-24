import { inspectDesktopCandidate } from "./desktop-candidate-qa.mjs";
import {
  desktopComputerLifecycleReceiptIssues,
  observationsWithEvidence,
  readDesktopComputerLifecycleObservations,
  readDesktopComputerLifecycleReceipt,
} from "./desktop-computer-lifecycle.mjs";

function valueAfter(arguments_, name) {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
}

const arguments_ = process.argv.slice(2);
const known = new Set(["--artifact", "--dmg", "--observations", "--receipt"]);
for (let index = 0; index < arguments_.length; index += 2) {
  if (!known.has(arguments_[index]) || !arguments_[index + 1]) {
    throw new Error(`Unknown or incomplete computer lifecycle option ${arguments_[index] || "<empty>"}.`);
  }
}
for (const required of known) {
  if (!valueAfter(arguments_, required)) throw new Error(`${required} is required.`);
}
const candidate = inspectDesktopCandidate({
  channel: "direct",
  archivePath: valueAfter(arguments_, "--artifact"),
  dmgPath: valueAfter(arguments_, "--dmg"),
});
const receipt = readDesktopComputerLifecycleReceipt(valueAfter(arguments_, "--receipt"));
const observations = readDesktopComputerLifecycleObservations(valueAfter(arguments_, "--observations"));
const checks = observationsWithEvidence(observations);
const evidence = checks.map((check) => check.evidence);
const issues = desktopComputerLifecycleReceiptIssues(receipt, { candidate, evidence, checks });
process.stdout.write(`${JSON.stringify({
  status: issues.length ? "blocked" : "passed",
  gate: receipt.gate,
  candidateFingerprint: receipt.candidateFingerprint,
  issues,
}, null, 2)}\n`);
if (issues.length) process.exitCode = 1;
