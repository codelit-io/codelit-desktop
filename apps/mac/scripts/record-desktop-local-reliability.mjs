import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { inspectDesktopCandidate } from "./desktop-candidate-qa.mjs";
import {
  createDesktopLocalReliabilityReceipt,
  observationsWithReliabilityEvidence,
  readDesktopLocalReliabilityObservations,
} from "./desktop-local-reliability.mjs";

function parseArguments(arguments_) {
  const values = new Map();
  const valueOptions = new Set(["--channel", "--artifact", "--dmg", "--package", "--observations", "--output"]);
  let attested = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (valueOptions.has(argument)) {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      if (values.has(argument)) throw new Error(`${argument} can be provided only once.`);
      values.set(argument, value);
      index += 1;
    } else if (argument === "--attest" && !attested) {
      attested = true;
    } else {
      throw new Error(`Unknown local reliability option ${argument}.`);
    }
  }
  const channel = values.get("--channel");
  if (!["direct", "app-store"].includes(channel)) throw new Error("Use --channel direct or --channel app-store.");
  for (const required of ["--observations", "--output"]) {
    if (!values.has(required)) throw new Error(`${required} is required.`);
  }
  if (channel === "direct" && (!values.has("--artifact") || !values.has("--dmg") || values.has("--package"))) {
    throw new Error("Direct reliability recording requires --artifact and --dmg only.");
  }
  if (channel === "app-store" && (!values.has("--package") || values.has("--artifact") || values.has("--dmg"))) {
    throw new Error("App Store reliability recording requires --package only.");
  }
  if (!attested) throw new Error("--attest is required after reviewing every exact proof bundle.");
  return values;
}

const values = parseArguments(process.argv.slice(2));
const output = resolve(values.get("--output"));
if (existsSync(output)) throw new Error(`Refusing to replace existing local reliability receipt ${output}.`);
const channel = values.get("--channel");
const candidate = inspectDesktopCandidate({
  channel,
  ...(channel === "direct"
    ? { archivePath: values.get("--artifact"), dmgPath: values.get("--dmg") }
    : { packagePath: values.get("--package") }),
});
const observations = readDesktopLocalReliabilityObservations(values.get("--observations"));
const checks = observationsWithReliabilityEvidence(observations, { candidate });
const receipt = createDesktopLocalReliabilityReceipt({
  candidate,
  startedAt: observations.startedAt,
  completedAt: observations.completedAt,
  macOSVersion: observations.macOSVersion,
  hardware: observations.hardware,
  checks,
  signedAt: new Date().toISOString(),
});
writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
process.stdout.write(`${JSON.stringify({ status: "passed", gate: receipt.gate, output }, null, 2)}\n`);
