import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  desktopRendererBundleIssues,
  inspectDesktopRendererBundle,
} from "../../apps/mac/scripts/check-renderer-bundle.mjs";

const deferredNames = [
  "BotMarkdown-test.js",
  "ProviderCenter-test.js",
  "LocalBrowserPanel-test.js",
  "BotBrowserTeachingActivity-test.js",
  "BotBrowserSkillRunActivity-test.js",
];

function rendererFixture() {
  const dist = mkdtempSync(join(tmpdir(), "codelit-renderer-bundle-"));
  const assets = join(dist, "assets");
  mkdirSync(assets);
  writeFileSync(join(dist, "index.html"), [
    '<script type="module" src="/assets/index-test.js"></script>',
    '<link rel="modulepreload" href="/assets/runtime-test.js">',
  ].join("\n"));
  writeFileSync(join(assets, "index-test.js"), "export const app = true;");
  writeFileSync(join(assets, "runtime-test.js"), "export const runtime = true;");
  for (const name of deferredNames) writeFileSync(join(assets, name), `export const chunk = "${name}";`);
  return dist;
}

describe("Codelit for Mac renderer bundle budget", () => {
  it("distinguishes initial JavaScript from deferred product surfaces", () => {
    const report = inspectDesktopRendererBundle(rendererFixture());
    expect(report.initial.map((asset) => asset.name)).toEqual(["index-test.js", "runtime-test.js"]);
    expect(report.deferred.map((asset) => asset.name)).toEqual(deferredNames.slice().sort());
    expect(desktopRendererBundleIssues(report)).toEqual([]);
  });

  it("fails when startup, deferred, or total JavaScript exceeds its budget", () => {
    const report = inspectDesktopRendererBundle(rendererFixture());
    const issues = desktopRendererBundleIssues(report, {
      entryBytes: 1,
      initialGzipBytes: 1,
      largestDeferredGzipBytes: 1,
      totalGzipBytes: 1,
    });
    expect(issues).toHaveLength(4);
    expect(issues.join(" ")).toContain("Initial JavaScript");
    expect(issues.join(" ")).toContain("Largest deferred chunk");
  });
});
