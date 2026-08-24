import { appStoreSubmissionIssues, readAppStoreSubmission } from "./app-store-submission.mjs";

const arguments_ = process.argv.slice(2);
const release = arguments_.includes("--release");
const json = arguments_.includes("--json");
const issues = appStoreSubmissionIssues(readAppStoreSubmission(), {
  requireScreenshots: release,
});
const report = { mode: release ? "release" : "structure", ready: issues.length === 0, issues };

if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  process.stdout.write(`Codelit Mac App Store submission: ${report.ready ? "ready" : "blocked"} (${report.mode})\n`);
  for (const issue of issues) process.stdout.write(`- ${issue}\n`);
}
if (!report.ready) process.exitCode = 1;
