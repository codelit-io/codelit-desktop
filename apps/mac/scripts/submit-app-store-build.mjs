import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  appStoreDirectory,
  appStoreSubmissionPath,
  appStoreSubmissionIssues,
  readAppStoreSubmission,
} from "./app-store-submission.mjs";
import {
  candidateQaReceiptIssues,
  inspectDesktopCandidate,
  readCandidateQaReceipt,
} from "./desktop-candidate-qa.mjs";

export const appStoreCandidateQaStage = "testflight-upload";

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function writeDeliveryReceipt(file, receipt) {
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  ftruncateSync(file, 0);
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(file, bytes, offset, bytes.length - offset, offset);
  }
  fsyncSync(file);
}

function valueAfter(arguments_, name) {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
}

function requiredFile(path, label) {
  if (!path) throw new Error(`${label} is required.`);
  const absolute = resolve(path);
  if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isFile()) {
    throw new Error(`${label} must be a non-symlink regular file.`);
  }
  return absolute;
}

function altool(arguments_, environment) {
  const result = spawnSync("xcrun", ["altool", ...arguments_], {
    encoding: "utf8",
    env: environment,
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (result.status !== 0) throw new Error(`App Store Connect rejected the candidate: ${output || "unknown altool error"}`);
  try {
    return JSON.parse(output);
  } catch {
    return { output };
  }
}

export function appStoreDeliveryPlan({ upload, packagePath, authentication }) {
  const plan = [
    ["--validate-app", packagePath, ...authentication],
  ];
  if (upload) plan.push(["--upload-package", packagePath, "--wait", ...authentication]);
  return plan;
}

export function submitAppStoreBuild(arguments_, environment = process.env) {
  const upload = arguments_.includes("--upload");
  const known = new Set(["--package", "--qa-receipt", "--output", "--upload"]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!known.has(argument)) throw new Error(`Unknown App Store option ${argument}.`);
    if (argument !== "--upload") index += 1;
  }
  const output = valueAfter(arguments_, "--output");
  if (upload && !output) throw new Error("--output is required for App Store upload so an interrupted delivery remains auditable.");
  const outputPath = output ? resolve(output) : null;
  if (outputPath && existsSync(outputPath)) throw new Error(`Refusing to replace existing delivery receipt ${outputPath}.`);
  const packagePath = requiredFile(valueAfter(arguments_, "--package"), "--package");
  const qaPath = requiredFile(valueAfter(arguments_, "--qa-receipt"), "--qa-receipt");
  const keyPath = requiredFile(environment.APPLE_API_KEY_PATH, "APPLE_API_KEY_PATH");
  if (!environment.APPLE_API_KEY || !environment.APPLE_API_ISSUER) {
    throw new Error("Set APPLE_API_KEY, APPLE_API_ISSUER, and APPLE_API_KEY_PATH for App Store Connect.");
  }
  const submission = readAppStoreSubmission();
  const metadataIssues = appStoreSubmissionIssues(submission, {
    requireDeliveryMetadata: true,
    requireScreenshots: false,
    environment,
  });
  if (metadataIssues.length) throw new Error(`App Store submission is incomplete: ${metadataIssues.join(" ")}`);
  const candidate = inspectDesktopCandidate({ channel: "app-store", packagePath });
  const qaReceipt = readCandidateQaReceipt(qaPath);
  const qaIssues = candidateQaReceiptIssues(qaReceipt, { candidate, stage: appStoreCandidateQaStage });
  if (qaIssues.length) throw new Error(`Signed-candidate QA failed: ${qaIssues.join(" ")}`);
  const authentication = [
    "--api-key", environment.APPLE_API_KEY,
    "--api-issuer", environment.APPLE_API_ISSUER,
    "--p8-file-path", keyPath,
    "--output-format", "json",
  ];
  const [validationArguments, uploadArguments] = appStoreDeliveryPlan({ upload, packagePath, authentication });
  const startedAt = new Date().toISOString();
  const receipt = {
    schemaVersion: 1,
    action: upload ? "upload" : "validation",
    status: "started",
    startedAt,
    completedAt: null,
    failedAt: null,
    appStoreAppId: environment.CODELIT_APP_STORE_APP_ID,
    package: {
      name: basename(packagePath),
      version: candidate.version,
      build: candidate.build,
      candidateFingerprint: qaReceipt.candidateFingerprint,
      candidateQa: {
        sha256: sha256File(qaPath),
        receipt: qaReceipt,
      },
    },
    submission: {
      metadataSha256: sha256File(appStoreSubmissionPath),
      screenshotStage: "post-testflight-install",
      screenshots: submission.screenshots.slots.flatMap((slot) => {
        const path = resolve(appStoreDirectory, "screenshots", slot.file);
        return existsSync(path) ? [{ file: slot.file, sha256: sha256File(path) }] : [];
      }),
      exportComplianceReference: environment.CODELIT_APP_STORE_EXPORT_COMPLIANCE_REFERENCE,
    },
    validation: null,
    delivery: null,
  };
  const receiptFile = outputPath ? openSync(outputPath, "wx", 0o600) : null;
  if (receiptFile !== null) writeDeliveryReceipt(receiptFile, receipt);
  try {
    receipt.validation = altool(validationArguments, environment);
    receipt.delivery = uploadArguments ? altool(uploadArguments, environment) : null;
    receipt.status = "completed";
    receipt.completedAt = new Date().toISOString();
    if (receiptFile !== null) writeDeliveryReceipt(receiptFile, receipt);
    return receipt;
  } catch (error) {
    receipt.status = "failed";
    receipt.failedAt = new Date().toISOString();
    if (receiptFile !== null) writeDeliveryReceipt(receiptFile, receipt);
    throw error;
  } finally {
    if (receiptFile !== null) closeSync(receiptFile);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.write(`${JSON.stringify(submitAppStoreBuild(process.argv.slice(2)), null, 2)}\n`);
}
