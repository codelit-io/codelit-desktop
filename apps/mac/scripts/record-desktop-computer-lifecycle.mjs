import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { inspectDesktopCandidate } from "./desktop-candidate-qa.mjs";
import {
  createDesktopComputerLifecycleReceipt,
  observationsWithEvidence,
  readDesktopComputerLifecycleObservations,
} from "./desktop-computer-lifecycle.mjs";

function parseArguments(arguments_) {
  const values = new Map();
  const valueOptions = new Set(["--artifact", "--dmg", "--observations", "--output"]);
  let attested = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (valueOptions.has(argument)) {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      values.set(argument, value);
      index += 1;
    } else if (argument === "--attest" && !attested) {
      attested = true;
    } else {
      throw new Error(`Unknown computer lifecycle option ${argument}.`);
    }
  }
  for (const required of valueOptions) {
    if (!values.has(required)) throw new Error(`${required} is required.`);
  }
  if (!attested) throw new Error("--attest is required after reviewing every exact proof bundle.");
  return values;
}

const values = parseArguments(process.argv.slice(2));
const output = resolve(values.get("--output"));
if (existsSync(output)) throw new Error(`Refusing to replace existing computer lifecycle receipt ${output}.`);
const candidate = inspectDesktopCandidate({
  channel: "direct",
  archivePath: values.get("--artifact"),
  dmgPath: values.get("--dmg"),
});
const observations = readDesktopComputerLifecycleObservations(values.get("--observations"));
const checks = observationsWithEvidence(observations);
const receipt = createDesktopComputerLifecycleReceipt({
  candidate,
  startedAt: observations.startedAt,
  completedAt: observations.completedAt,
  macOSVersion: observations.macOSVersion,
  targetApp: observations.targetApp,
  checks,
  signedAt: new Date().toISOString(),
});
writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
process.stdout.write(`${JSON.stringify({ status: "passed", gate: receipt.gate, output }, null, 2)}\n`);
