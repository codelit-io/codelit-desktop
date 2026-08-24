import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createCandidateQaDraft, inspectDesktopCandidate } from "./desktop-candidate-qa.mjs";

function valueAfter(arguments_, name) {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
}

const arguments_ = process.argv.slice(2);
const channel = valueAfter(arguments_, "--channel");
const output = valueAfter(arguments_, "--output");
if (!output) throw new Error("--output is required.");
const outputPath = resolve(output);
if (existsSync(outputPath)) throw new Error(`Refusing to replace existing receipt ${outputPath}.`);
const candidate = inspectDesktopCandidate({
  channel,
  archivePath: valueAfter(arguments_, "--artifact"),
  dmgPath: valueAfter(arguments_, "--dmg"),
  packagePath: valueAfter(arguments_, "--package"),
});
writeFileSync(outputPath, `${JSON.stringify(createCandidateQaDraft(candidate), null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify({ status: "pending", channel, output: outputPath }, null, 2)}\n`);
