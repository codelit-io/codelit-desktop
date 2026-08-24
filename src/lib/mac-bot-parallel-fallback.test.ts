import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendThreadMessage,
  bootstrapBots,
  clearLocalBotMemories,
  createLocalBot,
  createLocalBotDelegation,
  createLocalBotMemoryProposal,
  finishLocalBotDelegationTarget,
  listLocalBotGroupMembers,
  listLocalBotDelegations,
  listLocalBotMemories,
  listLocalBotMemoryProposals,
  localRunCapacityDetail,
  reviewLocalBotMemoryProposal,
  setActiveLocalBot,
  startLocalBotDelegationTarget,
  updateLocalBotGroupMembers,
  updateLocalBotEnginePolicy,
  updateLocalBotProfile,
} from "../../apps/mac/src/runtime";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const CREATED_AT = "2026-08-14T00:00:00.000Z";

function avatarPngDataUrl(width = 256, height = 256) {
  const bytes = Buffer.from([
    137, 80, 78, 71, 13, 10, 26, 10,
    0, 0, 0, 13,
    73, 72, 68, 82,
    (width >>> 24) & 255, (width >>> 16) & 255, (width >>> 8) & 255, width & 255,
    (height >>> 24) & 255, (height >>> 16) & 255, (height >>> 8) & 255, height & 255,
    8, 6, 0, 0, 0,
    0, 0, 0, 0,
  ]);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

describe("Mac preview parallel bot persistence", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves an inactive bot completion without replacing the selected bot", async () => {
    const starter = await bootstrapBots();
    expect(starter.activeBot.spec.appearance?.avatar)
      .toEqual({ kind: "preset", preset: "mountain" });
    const alpha = await createLocalBot({
      id: "bot-alpha",
      name: "Alpha",
      job: "Complete Alpha work.",
      createdAt: CREATED_AT,
    });
    const alphaWorkspace = alpha.workspace;
    const beta = await createLocalBot({
      id: "bot-beta",
      name: "Beta",
      job: "Complete Beta work.",
      createdAt: CREATED_AT,
    });

    await appendThreadMessage(alphaWorkspace, "Alpha completed in the background.", "assistant");

    const stillBeta = await bootstrapBots();
    expect(stillBeta.activeBot.id).toBe("bot-beta");
    expect(stillBeta.workspace.thread.id).toBe(beta.workspace.thread.id);
    expect(stillBeta.workspace.blocks.some((block) => (
      block.type === "assistant-message" && block.text.includes("Alpha completed")
    ))).toBe(false);

    const selectedAlpha = await setActiveLocalBot("bot-alpha");
    expect(selectedAlpha.workspace.thread.id).toBe(alphaWorkspace.thread.id);
    expect(selectedAlpha.workspace.blocks.some((block) => (
      block.type === "assistant-message" && block.text === "Alpha completed in the background."
    ))).toBe(true);
  });

  it("persists a bounded conversation team independently for each owner", async () => {
    const starter = await bootstrapBots();
    const alpha = (await createLocalBot({
      id: "bot-group-alpha",
      name: "Alpha",
      job: "Investigate one bounded concern.",
      createdAt: CREATED_AT,
    })).activeBot;
    const beta = (await createLocalBot({
      id: "bot-group-beta",
      name: "Beta",
      job: "Verify one bounded concern.",
      createdAt: CREATED_AT,
    })).activeBot;

    await updateLocalBotGroupMembers({
      ownerBotId: starter.activeBot.id,
      memberBotIds: [alpha.id, beta.id],
      updatedAt: CREATED_AT,
    });
    expect((await listLocalBotGroupMembers(starter.activeBot.id)).map((bot) => bot.id))
      .toEqual([alpha.id, beta.id]);
    expect(await listLocalBotGroupMembers(alpha.id)).toEqual([]);

    await updateLocalBotGroupMembers({
      ownerBotId: starter.activeBot.id,
      memberBotIds: [beta.id],
      updatedAt: "2026-08-14T00:01:00.000Z",
    });
    expect((await listLocalBotGroupMembers(starter.activeBot.id)).map((bot) => bot.id))
      .toEqual([beta.id]);
    await expect(updateLocalBotGroupMembers({
      ownerBotId: starter.activeBot.id,
      memberBotIds: [alpha.id, beta.id, "bot-extra"],
      updatedAt: CREATED_AT,
    })).rejects.toThrow("one or two");
  });

  it("versions an inactive bot profile without switching bots and persists its renamed Thread", async () => {
    await bootstrapBots();
    await createLocalBot({
      id: "bot-alpha",
      name: "Alpha",
      job: "Complete Alpha work.",
      avatar: { kind: "preset", preset: "orbit" },
      createdAt: CREATED_AT,
    });
    await createLocalBot({
      id: "bot-beta",
      name: "Beta",
      job: "Complete Beta work.",
      createdAt: CREATED_AT,
    });

    const dataUrl = avatarPngDataUrl();
    const updated = await updateLocalBotProfile(
      "bot-alpha",
      "  Signal Alpha  ",
      { kind: "image", dataUrl },
    );
    expect(updated).toMatchObject({
      id: "bot-alpha",
      name: "Signal Alpha",
      currentVersion: 2,
      spec: {
        version: 2,
        name: "Signal Alpha",
        appearance: { avatar: { kind: "image", dataUrl } },
      },
    });

    const stillBeta = await bootstrapBots();
    expect(stillBeta.activeBot.id).toBe("bot-beta");
    const selectedAlpha = await setActiveLocalBot("bot-alpha");
    expect(selectedAlpha.activeBot.name).toBe("Signal Alpha");
    expect(selectedAlpha.workspace.thread.title).toBe("Signal Alpha");

    await expect(updateLocalBotProfile(
      "bot-alpha",
      "Should Not Persist",
      { kind: "image", dataUrl: avatarPngDataUrl(255, 256) },
    )).rejects.toThrow("256 by 256");
    const unchanged = await bootstrapBots();
    expect(unchanged.activeBot.name).toBe("Signal Alpha");
    expect(unchanged.activeBot.currentVersion).toBe(2);
  });

  it("keeps a bot's fixed or automatic engine policy scoped and durable", async () => {
    await bootstrapBots();
    await createLocalBot({
      id: "bot-alpha",
      name: "Alpha",
      job: "Use a fixed engine.",
      createdAt: CREATED_AT,
    });
    await createLocalBot({
      id: "bot-beta",
      name: "Beta",
      job: "Stay automatic.",
      createdAt: CREATED_AT,
    });

    const updated = await updateLocalBotEnginePolicy("bot-alpha", {
      mode: "fixed",
      allowedProviders: ["codex", "openai"],
      fixedEngine: { provider: "openai", model: "gpt-5.4-mini" },
      allowMeteredFallback: false,
    });
    expect(updated).toMatchObject({
      currentVersion: 2,
      spec: {
        enginePolicy: {
          mode: "fixed",
          allowedProviders: ["codex", "openai"],
          fixedEngine: { provider: "openai", model: "gpt-5.4-mini" },
          allowMeteredFallback: false,
        },
      },
    });

    const beta = await bootstrapBots();
    expect(beta.activeBot.id).toBe("bot-beta");
    expect(beta.activeBot.spec.enginePolicy.mode).toBe("auto");
    const alpha = await setActiveLocalBot("bot-alpha");
    expect(alpha.activeBot.spec.enginePolicy.fixedEngine)
      .toEqual({ provider: "openai", model: "gpt-5.4-mini" });
  });

  it("mirrors provider-aware specialist queueing in the browser preview", async () => {
    const parent = (await bootstrapBots()).activeBot;
    const first = (await createLocalBot({
      id: "bot-capacity-first",
      name: "First Specialist",
      job: "Review the first bounded concern.",
      createdAt: CREATED_AT,
    })).activeBot;
    const second = (await createLocalBot({
      id: "bot-capacity-second",
      name: "Second Specialist",
      job: "Review the second bounded concern.",
      createdAt: CREATED_AT,
    })).activeBot;
    const delegation = await createLocalBotDelegation({
      id: "delegation-capacity",
      parentBotId: parent.id,
      targetBotIds: [first.id, second.id],
      task: "Review one release candidate.",
      expectedOutput: "One concise finding.",
      maxActions: 4,
      deadlineAt: "2099-08-19T12:30:00.000Z",
      sharedMemorySnapshotHash: "none",
      createdAt: "2099-08-19T12:00:00.000Z",
    });
    await startLocalBotDelegationTarget({
      id: delegation.id,
      targetBotId: first.id,
      runId: "run-capacity-first",
      providerId: "codex",
      providerQuotaState: "limited",
      startedAt: "2099-08-19T12:01:00.000Z",
    });
    let capacityError: unknown;
    try {
      await startLocalBotDelegationTarget({
        id: delegation.id,
        targetBotId: second.id,
        runId: "run-capacity-second",
        providerId: "codex",
        providerQuotaState: "limited",
        startedAt: "2099-08-19T12:01:01.000Z",
      });
    } catch (reason) {
      capacityError = reason;
    }
    expect(localRunCapacityDetail(capacityError)).toContain("capacity is limited");
    const queued = (await listLocalBotDelegations(parent.id))[0];
    expect(queued.targets[1]).toMatchObject({
      status: "queued",
      detail: expect.stringContaining("capacity is limited"),
    });

    await finishLocalBotDelegationTarget({
      id: delegation.id,
      targetBotId: first.id,
      runId: "run-capacity-first",
      outcome: "completed",
      result: "First result",
      finishedAt: "2099-08-19T12:02:00.000Z",
    });
    const resumed = await startLocalBotDelegationTarget({
      id: delegation.id,
      targetBotId: second.id,
      runId: "run-capacity-second",
      providerId: "codex",
      providerQuotaState: "limited",
      startedAt: "2099-08-19T12:02:01.000Z",
    });
    expect(resumed.targets[1]).toMatchObject({ status: "running", providerId: "codex" });
    expect(resumed.targets[1].detail).toBeUndefined();
  });

  it("keeps inferred memory pending until scope and expiry are reviewed", async () => {
    const bot = (await bootstrapBots()).activeBot;
    const proposal = await createLocalBotMemoryProposal({
      id: "memory-proposal-preview",
      actorBotId: bot.id,
      kind: "preference",
      body: "I prefer concise release summaries",
      sourceRunId: "run-preview-memory",
      createdAt: "2026-08-19T12:00:00.000Z",
    });
    expect(proposal).toMatchObject({
      approvalState: "pending",
      source: "inferred",
      sourceRunId: "run-preview-memory",
    });
    expect(await listLocalBotMemories(bot.id)).toEqual([]);
    expect(await listLocalBotMemoryProposals(bot.id)).toHaveLength(1);

    const approved = await reviewLocalBotMemoryProposal({
      id: proposal!.id,
      actorBotId: bot.id,
      decision: "approve",
      scope: "workspace",
      expiresAt: "2099-09-18T12:01:00.000Z",
      reviewedAt: "2026-08-19T12:01:00.000Z",
    });
    expect(approved).toMatchObject({
      scope: "workspace",
      source: "inferred",
      sourceRunId: "run-preview-memory",
      expiresAt: "2099-09-18T12:01:00.000Z",
    });
    expect(await listLocalBotMemoryProposals(bot.id)).toEqual([]);

    await createLocalBotMemoryProposal({
      id: "memory-proposal-preview-clear",
      actorBotId: bot.id,
      kind: "decision",
      body: "We decided to ship on Tuesdays",
      sourceRunId: "run-preview-memory-two",
      createdAt: "2026-08-19T12:02:00.000Z",
    });
    expect(await clearLocalBotMemories(bot.id, true)).toBe(2);
    expect(await listLocalBotMemories(bot.id)).toEqual([]);
    expect(await listLocalBotMemoryProposals(bot.id)).toEqual([]);
  });
});
