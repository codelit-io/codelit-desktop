import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDesktopComputerLifecycleObservationDraft } from "./desktop-computer-lifecycle.mjs";

function outputPath(arguments_) {
  if (arguments_.length !== 2 || arguments_[0] !== "--output" || !arguments_[1]) {
    throw new Error("Use --output /absolute/path/computer-lifecycle-observations.json.");
  }
  return resolve(arguments_[1]);
}

const output = outputPath(process.argv.slice(2));
if (existsSync(output)) throw new Error(`Refusing to replace existing observations ${output}.`);
writeFileSync(
  output,
  `${JSON.stringify(createDesktopComputerLifecycleObservationDraft(), null, 2)}\n`,
  { flag: "wx", mode: 0o600 },
);
process.stdout.write(`${JSON.stringify({ status: "pending", gate: "p5-computer-lifecycle", output }, null, 2)}\n`);
