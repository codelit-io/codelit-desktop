import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { readLocalProjectFile, readSelectedFiles, chooseWorkspaceDocument } from "../../apps/mac/src/runtime";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class { onmessage = () => {}; },
}));

describe("Explicit Mac project-file reads", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.mocked(invoke).mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reads the exact requested file through the existing bounded native tool", async () => {
    const result = {
      status: "completed",
      context: ["File acceptance.txt:\nFirst acceptance line.\nSecond acceptance line.\n"],
      completedTools: [{ toolId: "selected-files-read", toolName: "Selected files" }],
      browserProofs: [],
    };
    vi.mocked(invoke).mockResolvedValue(result);
    expect(await readLocalProjectFile("file-qa", "acceptance.txt", () => {})).toBe(result);
    expect(invoke).toHaveBeenCalledWith("run_local_tool_batch", {
      request: {
        runId: "file-qa",
        tools: ["Selected files"],
        handoff: "FILES: acceptance.txt",
        toolInputs: {},
      },
      onEvent: expect.anything(),
    });
  });

  it.each(["../outside.txt", "/tmp/outside.txt", "docs/../../outside.txt", "one.txt,two.txt", "one.txt two.txt"])(
    "rejects a path that could escape or expand the requested file: %s", async (path) => {
      await expect(readLocalProjectFile("file-qa", path, () => {})).rejects.toThrow("one file inside the connected project");
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("preserves native denials for protected, symlinked, unavailable, or oversized files", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("The selected file is not available for this scoped read."));
    await expect(readLocalProjectFile("file-qa", "acceptance.txt", () => {})).rejects.toThrow("not available");
  });

  it("binds a picked read to the approved root instead of whichever folder is current later", async () => {
    await readSelectedFiles("picked", 'FILES: ["src/app.ts"]', () => {}, "/approved/a");
    expect(invoke).toHaveBeenCalledWith("run_local_tool_batch", {
      request: {
        runId: "picked",
        tools: ["Selected files"],
        handoff: 'FILES: ["src/app.ts"]',
        toolInputs: { "Selected files": { expectedRoot: "/approved/a" } },
      },
      onEvent: expect.anything(),
    });
  });

  it("passes a picked document as a lossless JSON selection", async () => {
    const handoff = `FILES: ${JSON.stringify(["Supplier's A.txt"])}`;
    vi.mocked(invoke).mockResolvedValue({
      status: "completed",
      context: ["File Supplier's A.txt (1 lines total):\n    1 | Proposal\n"],
      completedTools: [{ toolId: "selected-files-read", toolName: "Selected files" }],
      browserProofs: [],
    });
    await readSelectedFiles("file-qa", handoff, () => {});
    expect(invoke).toHaveBeenCalledWith("run_local_tool_batch", {
      request: {
        runId: "file-qa",
        tools: ["Selected files"],
        handoff,
        toolInputs: {},
      },
      onEvent: expect.anything(),
    });
  });

  it("requests the native picker only for the currently approved root", async () => {
    await chooseWorkspaceDocument("/approved/a");
    expect(invoke).toHaveBeenCalledWith("choose_workspace_document", { expectedRoot: "/approved/a" });
  });
});
