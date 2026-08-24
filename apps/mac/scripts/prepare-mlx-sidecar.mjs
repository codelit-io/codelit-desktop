import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productRoot = path.join(
  os.tmpdir(),
  "codelit-mlx-build/Build/Products/Release",
);
const helperSource = path.join(productRoot, "codelit-mlx-helper");
const tauriRoot = path.join(appRoot, "src-tauri");
const targetTriple = process.arch === "arm64" ? "aarch64-apple-darwin" : null;

if (process.platform !== "darwin" || !targetTriple) {
  throw new Error("The bundled MLX helper currently supports Apple Silicon macOS only.");
}

const helperDestination = path.join(
  tauriRoot,
  "binaries",
  `codelit-mlx-helper-${targetTriple}`,
);
const resourcesDestination = path.join(tauriRoot, "resources/mlx");
const resourceBundles = [
  "mlx-swift_Cmlx.bundle",
  "swift-transformers_Hub.bundle",
  "swift-crypto_Crypto.bundle",
];

await mkdir(path.dirname(helperDestination), { recursive: true });
await rm(resourcesDestination, { recursive: true, force: true });
await mkdir(resourcesDestination, { recursive: true });
await cp(helperSource, helperDestination);
await chmod(helperDestination, 0o755);

const normalizationProbe = await execFileAsync(helperDestination, [
  "--normalize-output",
  '{"summary":"ready"}',
]);
const normalized = JSON.parse(normalizationProbe.stdout);
if (
  normalized.summary !== "ready" ||
  !Array.isArray(normalized.items) ||
  normalized.items.length !== 0
) {
  throw new Error("The bundled MLX helper did not normalize a summary-only response.");
}

const plainTextProbe = await execFileAsync(helperDestination, [
  "--normalize-output",
  "Hi! What should we work on?",
]);
const plainText = JSON.parse(plainTextProbe.stdout);
if (
  plainText.summary !== "Hi! What should we work on?" ||
  !Array.isArray(plainText.items) ||
  plainText.items.length !== 0
) {
  throw new Error("The bundled MLX helper did not safely wrap a plain-text response.");
}

const hiddenReasoningProbe = await execFileAsync(helperDestination, [
  "--normalize-output",
  "<think>private reasoning</think>Ready to help.",
]);
const hiddenReasoning = JSON.parse(hiddenReasoningProbe.stdout);
if (hiddenReasoning.summary !== "Ready to help." || hiddenReasoning.summary.includes("private reasoning")) {
  throw new Error("The bundled MLX helper exposed hidden reasoning while normalizing output.");
}

for (const bundle of resourceBundles) {
  await cp(path.join(productRoot, bundle), path.join(resourcesDestination, bundle), {
    recursive: true,
  });
}

const helperHash = createHash("sha256")
  .update(await readFile(helperDestination))
  .digest("hex");
await writeFile(
  path.join(resourcesDestination, "build-manifest.json"),
  `${JSON.stringify(
    {
      helper: path.basename(helperDestination),
      sha256: helperHash,
      resourceBundles,
    },
    null,
    2,
  )}\n`,
);

console.log(`Staged ${path.basename(helperDestination)} (${helperHash.slice(0, 12)}...)`);
