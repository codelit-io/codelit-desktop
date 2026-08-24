import { spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { verifyReleaseDirectory } from "./desktop-release-provenance.mjs";
import {
  directReleaseRepositoryApi,
  immutablePublicationReceiptIssues,
  readDirectReleasePublication,
  readImmutablePublicationReceipt,
  remoteReleaseIssues,
  repositoryPublicationIssues,
} from "./direct-release-publication.mjs";
import { repositoryRoot } from "./release-support.mjs";

export const githubApiVersion = "2026-03-10";

function resolveFromRepository(path) {
  return resolve(repositoryRoot, path);
}

function requiredRegularFile(path, label) {
  const absolute = resolveFromRepository(path);
  if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isFile()) {
    throw new Error(`${label} must be a non-symlink regular file.`);
  }
  return absolute;
}

function requiredNewFile(path, label) {
  const absolute = resolveFromRepository(path);
  if (existsSync(absolute)) throw new Error(`${label} already exists at ${absolute}.`);
  const parent = dirname(absolute);
  if (!existsSync(parent) || lstatSync(parent).isSymbolicLink() || !statSync(parent).isDirectory()) {
    throw new Error(`${label} parent must be an existing non-symlink directory.`);
  }
  return absolute;
}

export function parseDirectPublicationArguments(arguments_, { action }) {
  const directory = arguments_[0];
  if (!directory || directory.startsWith("--")) {
    throw new Error(`Usage: ${action} <release-directory> --output <receipt> (--initial-release | --previous-manifest <path>)`);
  }
  const values = new Map();
  const flags = new Set();
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (["--output", "--previous-manifest", "--publication-receipt"].includes(argument)) {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      values.set(argument, value);
      index += 1;
    } else if (argument === "--initial-release") {
      flags.add(argument);
    } else {
      throw new Error(`Unknown Direct publication option ${argument}.`);
    }
  }
  if (!values.has("--output")) throw new Error("--output is required so every remote mutation has a durable receipt.");
  if (flags.has("--initial-release") === values.has("--previous-manifest")) {
    throw new Error("Choose exactly one of --initial-release or --previous-manifest.");
  }
  if (action === "activate" && !values.has("--publication-receipt")) {
    throw new Error("--publication-receipt is required before latest.json can be activated.");
  }
  if (action === "publish" && values.has("--publication-receipt")) {
    throw new Error("--publication-receipt belongs only to pointer activation.");
  }
  return {
    directory: resolveFromRepository(directory),
    outputPath: requiredNewFile(values.get("--output"), "Receipt output"),
    initialRelease: flags.has("--initial-release"),
    previousManifestPath: values.has("--previous-manifest")
      ? requiredRegularFile(values.get("--previous-manifest"), "Previous manifest")
      : undefined,
    publicationReceiptPath: values.has("--publication-receipt")
      ? requiredRegularFile(values.get("--publication-receipt"), "Immutable publication receipt")
      : undefined,
  };
}

export function releaseVerificationOptions(options, environment = process.env) {
  return {
    initialRelease: options.initialRelease,
    previousManifestPath: options.previousManifestPath,
    environment: {
      ...environment,
      PATH: `/opt/homebrew/opt/rustup/bin:${environment.PATH || ""}`,
      DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
    },
  };
}

export function runCommand(command, arguments_, { environment = process.env, allowNotFound = false } = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryRoot,
    env: environment,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (allowNotFound && result.status !== 0 && /HTTP 404|Not Found/i.test(output)) return null;
  if (result.status !== 0) throw new Error(`${command} failed: ${output || "unknown error"}`);
  return result.stdout || "";
}

export function githubApi(endpoint, { method = "GET", input, allowNotFound = false, environment } = {}) {
  const arguments_ = [
    "api",
    endpoint,
    "--method",
    method,
    "--header",
    `X-GitHub-Api-Version:${githubApiVersion}`,
    ...(input ? ["--input", input] : []),
  ];
  const output = runCommand("gh", arguments_, { environment, allowNotFound });
  return output === null || !output.trim() ? output : JSON.parse(output);
}

export function readRemotePublicationState(tag, environment = process.env) {
  return {
    repository: githubApi(directReleaseRepositoryApi, { environment }),
    immutableSettings: githubApi(`${directReleaseRepositoryApi}/immutable-releases`, { environment }),
    remoteRelease: githubApi(`${directReleaseRepositoryApi}/releases/tags/${encodeURIComponent(tag)}`, {
      environment,
      allowNotFound: true,
    }),
  };
}

export function verifyRemoteState(state, publication) {
  const issues = [
    ...repositoryPublicationIssues(state.repository, state.immutableSettings),
    ...remoteReleaseIssues(state.remoteRelease, publication),
  ];
  if (issues.length) throw new Error(issues.join(" "));
}

export function verifyPublicationReceipt(path, publication, state, previousManifest) {
  const receipt = readImmutablePublicationReceipt(path);
  const issues = immutablePublicationReceiptIssues(receipt, { publication, previousManifest, ...state });
  if (issues.length) throw new Error(`Immutable publication receipt failed: ${issues.join(" ")}`);
  return receipt;
}

export function writeDurableReceipt(receipt, descriptor) {
  ftruncateSync(descriptor, 0);
  writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  fsyncSync(descriptor);
}

export function openReceipt(path) {
  return openSync(path, "wx", 0o600);
}

export function closeReceipt(descriptor) {
  closeSync(descriptor);
}

export function downloadAndVerifyRemoteRelease(publication, options, environment = process.env) {
  const temporary = mkdtempSync(resolve(tmpdir(), `codelit-${publication.tag}-remote-`));
  try {
    for (const asset of publication.assets) {
      runCommand("curl", [
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        "--proto",
        "=https",
        "--tlsv1.2",
        "--header",
        "Cache-Control: no-cache",
        "--output",
        resolve(temporary, asset.name),
        asset.url,
      ], { environment });
    }
    copyFileSync(publication.latestPath, resolve(temporary, "latest.json"));
    return verifyReleaseDirectory(temporary, releaseVerificationOptions(options, environment));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function readRemotePointer(environment = process.env) {
  const value = githubApi(`${directReleaseRepositoryApi}/contents/latest.json?ref=main`, {
    environment,
    allowNotFound: true,
  });
  if (value === null) return null;
  if (value.type !== "file" || value.path !== "latest.json" || value.encoding !== "base64" || !value.sha) {
    throw new Error("The remote latest.json pointer has an unsupported GitHub representation.");
  }
  const canonical = String(value.content || "").replace(/\s/g, "");
  const bytes = Buffer.from(canonical, "base64");
  if (bytes.toString("base64") !== canonical) throw new Error("The remote latest.json pointer is not canonical base64.");
  return { bytes, sha: value.sha };
}

export function readLatestPointerCommit(environment = process.env) {
  const commits = githubApi(`${directReleaseRepositoryApi}/commits?path=latest.json&per_page=1`, { environment });
  const commit = Array.isArray(commits) ? commits[0] : null;
  if (!/^[a-f0-9]{40}$/.test(commit?.sha || "")) {
    throw new Error("GitHub did not return the latest.json commit SHA.");
  }
  return commit.sha;
}

export function readPreviousManifest(options) {
  return options.previousManifestPath
    ? { path: options.previousManifestPath, bytes: readFileSync(options.previousManifestPath) }
    : null;
}

export function publicationFromOptions(options) {
  return readDirectReleasePublication(options.directory);
}
