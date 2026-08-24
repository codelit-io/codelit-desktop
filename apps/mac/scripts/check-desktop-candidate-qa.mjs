import {
  candidateQaReceiptIssues,
  inspectDesktopCandidate,
  readCandidateQaReceipt,
} from "./desktop-candidate-qa.mjs";

function valueAfter(arguments_, name) {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
}

const arguments_ = process.argv.slice(2);
const known = new Set(["--channel", "--artifact", "--dmg", "--package", "--receipt", "--stage"]);
for (let index = 0; index < arguments_.length; index += 2) {
  if (!known.has(arguments_[index]) || !arguments_[index + 1]) {
    throw new Error(`Unknown or incomplete signed-candidate QA option ${arguments_[index] || "<empty>"}.`);
  }
}
const receiptPath = valueAfter(arguments_, "--receipt");
if (!receiptPath) throw new Error("--receipt is required.");
const stage = valueAfter(arguments_, "--stage") || "release";
const candidate = inspectDesktopCandidate({
  channel: valueAfter(arguments_, "--channel"),
  archivePath: valueAfter(arguments_, "--artifact"),
  dmgPath: valueAfter(arguments_, "--dmg"),
  packagePath: valueAfter(arguments_, "--package"),
});
const receipt = readCandidateQaReceipt(receiptPath);
const issues = candidateQaReceiptIssues(receipt, { candidate, stage });
const report = { status: issues.length ? "blocked" : "passed", channel: candidate.channel, stage, issues };
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (issues.length) process.exitCode = 1;
