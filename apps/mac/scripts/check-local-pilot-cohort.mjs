import { existsSync, lstatSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  buildLocalPilotCohortReceipt,
  parseLocalPilotCohortArguments,
  readLocalPilotCohortManifest,
  readLocalPilotReports,
} from "./local-pilot-cohort.mjs";

function pathInside(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function writeReceipt(path, receipt) {
  const output = resolve(path);
  const parent = dirname(output);
  if (!existsSync(parent) || !lstatSync(parent).isDirectory()) {
    throw new Error("The local pilot cohort output directory does not exist.");
  }
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, output);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return output;
}

const options = parseLocalPilotCohortArguments(process.argv.slice(2));
const reportsPath = resolve(options.reports);
const manifestPath = resolve(options.manifest);
if (options.output && pathInside(reportsPath, resolve(options.output))) {
  throw new Error("Write the cohort receipt outside the participant reports directory.");
}
if (options.output && resolve(options.output) === manifestPath) {
  throw new Error("The cohort receipt cannot replace its manifest.");
}

const manifestInput = readLocalPilotCohortManifest(manifestPath);
const reportInput = readLocalPilotReports(reportsPath);
const receipt = buildLocalPilotCohortReceipt({
  manifest: manifestInput.manifest,
  reports: reportInput.entries,
  inputIssues: [...manifestInput.issues, ...reportInput.issues],
  manifestDigest: manifestInput.digest,
  reportFiles: reportInput.files,
});
if (options.output) writeReceipt(options.output, receipt);
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
if (receipt.status !== "measurement-ready") process.exitCode = 1;
