import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const arguments_ = process.argv.slice(2);
const valueAfter = (name) => {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
};
const channel = valueAfter("--channel") || (arguments_.includes("--sandbox") ? "app-store" : "direct");
const bundle = resolve(
  valueAfter("--app") || resolve(scriptsDirectory, "../src-tauri/target/release/bundle/macos/Codelit.app"),
);

if (!new Set(["direct", "app-store"]).has(channel)) {
  throw new Error("Use --channel direct or --channel app-store.");
}
if (!existsSync(bundle)) throw new Error(`Codelit bundle was not found at ${bundle}.`);

const mainExecutable = resolve(bundle, "Contents/MacOS/codelit-mac");
const nestedExecutables = [
  resolve(bundle, "Contents/MacOS/codelit-mlx-helper"),
  ...(channel === "direct"
    ? [resolve(bundle, "Contents/MacOS/codelit-scheduler-helper")]
    : []),
];
const launchAgent = resolve(
  bundle,
  "Contents/Library/LaunchAgents/io.codelit.desktop.scheduler.plist",
);

if (channel === "app-store" && existsSync(launchAgent)) {
  throw new Error("The App Store bundle unexpectedly contains the Direct scheduler LaunchAgent.");
}
for (const executable of [mainExecutable, ...nestedExecutables]) {
  if (!existsSync(executable)) throw new Error(`Required executable is missing: ${executable}`);
}

const run = (command, commandArguments) => {
  const result = spawnSync(command, commandArguments, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
const childEntitlements = resolve(scriptsDirectory, "../src-tauri/entitlements/child-inherit.plist");
const appEntitlements = resolve(scriptsDirectory, "../src-tauri/entitlements/app-store.plist");

for (const executable of nestedExecutables) {
  run("codesign", [
    "--force",
    "--sign",
    "-",
    "--timestamp=none",
    ...(channel === "app-store" ? ["--entitlements", childEntitlements] : []),
    executable,
  ]);
}
run("codesign", [
  "--force",
  "--sign",
  "-",
  "--timestamp=none",
  ...(channel === "app-store" ? ["--entitlements", appEntitlements] : []),
  bundle,
]);
run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", bundle]);

process.stdout.write(`Ad hoc signed and verified ${channel} bundle at ${bundle}\n`);
