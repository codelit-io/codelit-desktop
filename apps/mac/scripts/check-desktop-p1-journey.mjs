import { inspectDesktopCandidate } from "./desktop-candidate-qa.mjs";
import {
  desktopP1JourneyEvidence,
  desktopP1JourneyReceiptIssues,
  p1EvidenceFile,
  readDesktopP1JourneyReceipt,
} from "./desktop-p1-journey.mjs";

function valueAfter(arguments_, name) {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
}

const arguments_ = process.argv.slice(2);
const known = new Set([
  "--artifact",
  "--dmg",
  "--receipt",
  ...desktopP1JourneyEvidence.map((entry) => `--${entry.id}-evidence`),
]);
for (let index = 0; index < arguments_.length; index += 2) {
  if (!known.has(arguments_[index]) || !arguments_[index + 1]) {
    throw new Error(`Unknown or incomplete P1 journey option ${arguments_[index] || "<empty>"}.`);
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
const receipt = readDesktopP1JourneyReceipt(valueAfter(arguments_, "--receipt"));
const evidence = desktopP1JourneyEvidence.map((entry) => (
  p1EvidenceFile(valueAfter(arguments_, `--${entry.id}-evidence`), entry.id)
));
const issues = desktopP1JourneyReceiptIssues(receipt, { candidate, evidence });
process.stdout.write(`${JSON.stringify({
  status: issues.length ? "blocked" : "passed",
  gate: receipt.gate,
  candidateFingerprint: receipt.candidateFingerprint,
  issues,
}, null, 2)}\n`);
if (issues.length) process.exitCode = 1;
