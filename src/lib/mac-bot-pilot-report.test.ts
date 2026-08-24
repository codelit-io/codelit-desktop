import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const nativeReport = readFileSync("apps/mac/src-tauri/src/pilot_metrics.rs", "utf8");
const nativeCommands = readFileSync("apps/mac/src-tauri/src/lib.rs", "utf8");
const runtime = readFileSync("apps/mac/src/runtime.ts", "utf8");
const app = readFileSync("apps/mac/src/BotsApp.tsx", "utf8");
const rendererQa = readFileSync("apps/mac/scripts/qa-desktop-renderer.mjs", "utf8");

describe("Codelit Mac private product report", () => {
  it("keeps measurement local and excludes user work from the export contract", () => {
    expect(nativeReport).toContain('const PILOT_REPORT_KIND: &str = "codelit-local-pilot-report"');
    expect(nativeReport).toContain("const PILOT_REPORT_SCHEMA_VERSION: u8 = 2");
    expect(nativeReport).toContain('source_commit: env!("CODELIT_SOURCE_COMMIT").into()');
    expect(nativeReport).toContain('source_dirty: env!("CODELIT_SOURCE_DIRTY") == "true"');
    expect(nativeReport).toContain("local_only: true");
    expect(nativeReport).toContain("automatic_upload: false");
    for (const excluded of [
      "prompt text",
      "browser content and URLs",
      "file names and contents",
      "screenshots",
      "memories",
      "credentials",
      "provider responses and model output",
      "local database rows",
    ]) {
      expect(nativeReport).toContain(`"${excluded}"`);
    }
  });

  it("accepts only fixed unexpected-action categories without a details field", () => {
    for (const category of ["unexpected-action", "unapproved-write", "sensitive-data", "other"]) {
      expect(nativeReport).toContain(`"${category}"`);
    }
    expect(nativeReport).toContain("Choose a valid unexpected-action category.");
    expect(runtime).toContain('invoke<LocalPilotReport>("record_local_unexpected_action", { category })');
    expect(runtime).not.toContain('record_local_unexpected_action", { category, detail');
  });

  it("wires preview, explicit export, and responsive renderer QA end to end", () => {
    for (const command of [
      "get_local_pilot_report",
      "record_local_unexpected_action",
      "export_local_pilot_report",
    ]) {
      expect(nativeCommands).toContain(command);
      expect(runtime).toContain(command);
      expect(rendererQa).toContain(command);
    }
    expect(app).toContain("Preview aggregate outcomes before choosing whether to export them.");
    expect(app).toContain("This stays on your Mac until you export it.");
    expect(rendererQa).toContain("settings-private-report-compact-dark.png");
  });
});
