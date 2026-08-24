import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { inspectDesktopCandidate } from "./desktop-candidate-qa.mjs";
import {
  createDesktopP1JourneyReceipt,
  desktopP1JourneyEvidence,
  p1EvidenceFile,
} from "./desktop-p1-journey.mjs";

function parseArguments(arguments_) {
  const values = new Map();
  const flags = new Set();
  const valueOptions = new Set([
    "--artifact",
    "--dmg",
    "--output",
    "--started-at",
    "--completed-at",
    "--macos-version",
    "--host",
    ...desktopP1JourneyEvidence.map((entry) => `--${entry.id}-evidence`),
  ]);
  const flagOptions = new Set(["--fresh-profile", "--attest"]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (valueOptions.has(argument)) {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      values.set(argument, value);
      index += 1;
    } else if (flagOptions.has(argument)) {
      flags.add(argument);
    } else {
      throw new Error(`Unknown P1 journey option ${argument}.`);
    }
  }
  for (const required of valueOptions) {
    if (!values.has(required)) throw new Error(`${required} is required.`);
  }
  for (const required of flagOptions) {
    if (!flags.has(required)) throw new Error(`${required} is required.`);
  }
  return { values };
}

const { values } = parseArguments(process.argv.slice(2));
const output = resolve(values.get("--output"));
if (existsSync(output)) throw new Error(`Refusing to replace existing P1 receipt ${output}.`);
const candidate = inspectDesktopCandidate({
  channel: "direct",
  archivePath: values.get("--artifact"),
  dmgPath: values.get("--dmg"),
});
const evidence = desktopP1JourneyEvidence.map((entry) => (
  p1EvidenceFile(values.get(`--${entry.id}-evidence`), entry.id)
));
const receipt = createDesktopP1JourneyReceipt({
  candidate,
  startedAt: values.get("--started-at"),
  completedAt: values.get("--completed-at"),
  macOSVersion: values.get("--macos-version"),
  host: values.get("--host").toLowerCase(),
  evidence,
  signedAt: new Date().toISOString(),
});
writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
process.stdout.write(`${JSON.stringify({ status: "passed", gate: receipt.gate, output }, null, 2)}\n`);
