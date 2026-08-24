import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { appRoot } from "./release-support.mjs";

function command(commandName, arguments_) {
  const result = spawnSync(commandName, arguments_, { encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || `${commandName} failed.`);
  }
}

function outputPath(arguments_) {
  if (arguments_.length !== 2 || arguments_[0] !== "--output" || !arguments_[1]) {
    throw new Error("Use --output /absolute/path/Codelit-Lifecycle-QA.app.");
  }
  return resolve(arguments_[1]);
}

const output = outputPath(process.argv.slice(2));
if (!output.endsWith(".app")) throw new Error("The lifecycle fixture output must end in .app.");
if (existsSync(output)) throw new Error(`Refusing to replace existing lifecycle fixture ${output}.`);

const sourceRoot = resolve(appRoot, "native/computer-lifecycle-fixture");
const executable = resolve(output, "Contents/MacOS/CodelitComputerLifecycleFixture");
mkdirSync(resolve(output, "Contents/MacOS"), { recursive: true, mode: 0o755 });
copyFileSync(resolve(sourceRoot, "Info.plist"), resolve(output, "Contents/Info.plist"));
command("xcrun", [
  "swiftc",
  "-O",
  "-framework",
  "AppKit",
  resolve(sourceRoot, "ComputerLifecycleFixture.swift"),
  "-o",
  executable,
]);
chmodSync(executable, 0o755);
command("codesign", [
  "--force",
  "--sign",
  "-",
  "--identifier",
  "io.codelit.qa.computer-lifecycle-fixture",
  output,
]);
command("codesign", ["--verify", "--deep", "--strict", "--verbose=2", output]);
process.stdout.write(`${JSON.stringify({ status: "ready", output }, null, 2)}\n`);
