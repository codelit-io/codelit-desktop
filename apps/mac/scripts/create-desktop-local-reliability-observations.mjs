import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDesktopLocalReliabilityObservationDraft } from "./desktop-local-reliability.mjs";

const arguments_ = process.argv.slice(2);
if (arguments_.length !== 2 || arguments_[0] !== "--output" || !arguments_[1]) {
  throw new Error("Use --output /absolute/path/local-reliability-observations.json.");
}
const output = resolve(arguments_[1]);
if (existsSync(output)) throw new Error(`Refusing to replace existing local reliability observations ${output}.`);
writeFileSync(output, `${JSON.stringify(createDesktopLocalReliabilityObservationDraft(), null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});
process.stdout.write(`${JSON.stringify({ status: "pending", gate: "p7-local-reliability", output }, null, 2)}\n`);
