import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import axe from "axe-core";
import { chromium } from "playwright";
import {
  rendererQaMatrices as matrices,
  rendererQaSurfaces as surfaces,
} from "./desktop-renderer-qa-receipt.mjs";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptsDirectory, "..");
const repositoryRoot = resolve(appRoot, "../..");
const builtinSkillManifests = JSON.parse(readFileSync(resolve(appRoot, "builtin-skills.json"), "utf8"));
const outputArgument = process.argv.indexOf("--output");
const outputDirectory = resolve(
  outputArgument >= 0 && process.argv[outputArgument + 1]
    ? process.argv[outputArgument + 1]
    : resolve(tmpdir(), `codelit-mac-renderer-qa-${Date.now()}`),
);
function commandOutput(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "unavailable";
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  if (!port) throw new Error("Could not reserve a local desktop QA port.");
  return port;
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("The desktop preview exited before QA started.");
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The preview is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`The desktop preview did not become ready at ${url}.`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function installParallelBotTauriFixture(fixtureInput) {
  const packagedSkillManifests = Array.isArray(fixtureInput)
    ? fixtureInput
    : fixtureInput.packagedSkillManifests;
  const enableMcp = !Array.isArray(fixtureInput) && fixtureInput.enableMcp === true;
  const CREATED_AT = "2026-08-14T00:00:00.000Z";
  const callbacks = new Map();
  const workspaces = new Map();
  const runOwners = new Map();
  const providerRuns = new Map();
  const cancelCalls = [];
  const approvalDecisions = [];
  const profileUpdates = [];
  const schedules = [];
  const eventRoutines = [];
  let autonomyPolicy = {
    globallyPaused: false,
    quietHoursEnabled: false,
    quietStart: "22:00",
    quietEnd: "07:00",
    dailyDigestEnabled: false,
    dailyDigestTime: "17:00",
    timezone: "America/Denver",
    status: "active",
    statusDetail: "Routines are active",
    canStartWork: true,
    updatedAt: CREATED_AT,
  };
  const memories = [];
  const memoryProposals = [];
  const skills = packagedSkillManifests.map((manifest) => ({
    ...manifest,
    source: "built-in",
    trustState: "packaged",
    checksum: "b".repeat(64),
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  }));
  const botTables = [];
  const botTableRows = new Map();
  const exportedBotTables = [];
  const quarantinedBrowserDownloads = [];
  const releasedBrowserDownloads = [];
  const delegations = [];
  const groupMembers = new Map();
  const computerScopes = [];
  const computerActions = [];
  const computerTakeOvers = [];
  const browserSessions = new Map();
  const browserTeachings = new Map();
  const preparedBrowserApprovals = new Map();
  const browserApprovals = [];
  const browserActions = [];
  const browserActionRuntimeValues = [];
  const preparedMcpApprovals = new Map();
  const mcpApprovals = [];
  const mcpActions = [];
  const unexpectedActionReports = [];
  const exportedPilotReports = [];
  let nextCallbackId = 1;
  let activeBotId = "bot-alpha";

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const timestamp = () => new Date().toISOString();
  const botSpec = (id, name, job, createdAt, avatar) => ({
    schemaVersion: 2,
    botId: id,
    version: 1,
    name,
    job,
    instructions: [
      "Start with the smallest useful result.",
      "Use only approved local context and identify uncertainty.",
      "Never claim an action happened unless a receipt confirms it.",
    ],
    enginePolicy: {
      mode: "auto",
      allowedProviders: ["codex"],
      allowMeteredFallback: false,
    },
    capabilityIds: ["conversation", "project-read", "browser-read"],
    permissionPolicy: {
      approvalMode: "ask",
      browserDomains: [],
      projectAccess: "ask",
      browserAccess: "ask",
      writeActions: "always-ask",
      computerUse: "ask",
    },
    autonomyPolicy: { mode: "manual", maxActionsPerRun: 8, allowBackground: false },
    memoryPolicy: { mode: "proposals", scopes: ["bot"], proposalReview: "required" },
    goal: {
      id: `goal-${id}`,
      outcome: job,
      successCriteria: [
        "Produce one concrete result backed by inspectable evidence.",
        "Keep external changes and sensitive actions behind approval.",
      ],
      status: "active",
      nextAction: "Take the smallest useful read-only step with the context available now.",
      createdAt,
      updatedAt: createdAt,
    },
    routineIds: [],
    appearance: { avatar },
    createdAt,
    updatedAt: createdAt,
  });
  const createBot = (
    id,
    name,
    job,
    createdAt = CREATED_AT,
    avatar = { kind: "preset", preset: "spark" },
  ) => ({
    id,
    threadId: `thread-${id}`,
    currentVersion: 1,
    name,
    status: "sleeping",
    latestStatus: "Ready for a task",
    spec: botSpec(id, name, job, createdAt, avatar),
    createdAt,
    updatedAt: createdAt,
  });
  const createWorkspace = (bot) => ({
    thread: {
      id: bot.threadId,
      ownerUid: "local-device",
      workspaceId: "local-workspace",
      projectId: "local-project",
      title: bot.name,
      status: "idle",
      latestBlockSequence: 1,
      activeArtifactRefs: [],
      createdAt: bot.createdAt,
      updatedAt: bot.updatedAt,
    },
    blocks: [{
      id: `block-welcome-${bot.id}`,
      sequence: 1,
      createdAt: bot.createdAt,
      type: "assistant-message",
      text: `I'm ${bot.name}. ${bot.spec.job} Give me one outcome and I will start with the safest useful step.`,
    }],
    artifacts: [{
      artifactId: "artifact-plan-ship-local",
      kind: "product-plan",
      version: "v1-local-plan",
      title: "Local Plan",
      projectId: "local-project",
      payload: { summary: "Private local plan" },
      createdAt: bot.createdAt,
    }],
    runEvents: [],
    runCheckpoints: [],
    approvals: [],
    receipts: [],
    artifactFiles: [],
    workspaceFolder: null,
    databasePath: "Renderer QA storage",
  });
  const botTableView = (table, limit = 200) => {
    const rows = botTableRows.get(table.id) || [];
    const visible = rows.slice(-limit).reverse();
    return {
      table: { ...clone(table), rowCount: rows.length },
      rows: clone(visible),
      totalRows: rows.length,
      truncated: rows.length > limit,
    };
  };

  const bots = [createBot(
    "bot-alpha",
    "Alpha",
    "Answer Alpha's release questions while other bots keep working.",
  )];
  workspaces.set(bots[0].threadId, createWorkspace(bots[0]));

  const findBot = (id) => {
    const bot = bots.find((candidate) => candidate.id === id);
    if (!bot) throw new Error(`Renderer QA bot not found: ${id}`);
    return bot;
  };
  const findWorkspace = (threadId) => {
    const workspace = workspaces.get(threadId);
    if (!workspace) throw new Error(`Renderer QA workspace not found: ${threadId}`);
    return workspace;
  };
  const catalog = () => ({
    bots: clone(bots),
    activeBot: clone(findBot(activeBotId)),
    workspace: clone(findWorkspace(findBot(activeBotId).threadId)),
  });
  const replaceBot = (id, update) => {
    const index = bots.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new Error(`Renderer QA bot not found: ${id}`);
    bots[index] = update(bots[index]);
    return clone(bots[index]);
  };
  const appendBlock = (workspace, block) => {
    const sequence = workspace.thread.latestBlockSequence + 1;
    workspace.thread.latestBlockSequence = sequence;
    workspace.thread.updatedAt = block.createdAt;
    workspace.blocks.push({ ...block, sequence });
    return sequence;
  };
  const ownerForRun = (runId) => {
    const owner = runOwners.get(runId);
    if (!owner) throw new Error(`Renderer QA run owner not found: ${runId}`);
    return owner;
  };
  const channelCallback = (run) => callbacks.get(run.channel.id)?.callback;
  const emitProviderEvent = (runId, eventType, message, payload) => {
    const run = providerRuns.get(runId);
    if (!run || run.settled) throw new Error(`Renderer QA provider run is not active: ${runId}`);
    const callback = channelCallback(run);
    if (!callback) throw new Error(`Renderer QA channel is unavailable for ${runId}`);
    const event = {
      runId,
      sequence: run.eventSequence + 1,
      eventType,
      provider: run.request.provider,
      model: run.request.model,
      message,
      ...(payload === undefined ? {} : { payload }),
      createdAt: timestamp(),
    };
    run.eventSequence += 1;
    callback({ index: run.channelIndex, message: event });
    run.channelIndex += 1;
    return clone(event);
  };
  const settleProviderRun = (runId, status, summary, items = []) => {
    const run = providerRuns.get(runId);
    if (!run || run.settled) throw new Error(`Renderer QA provider run is not active: ${runId}`);
    const structuredOutput = status === "completed" ? { summary, items } : undefined;
    emitProviderEvent(
      runId,
      status === "completed" ? "completed" : status === "canceled" ? "canceled" : "failed",
      summary,
      structuredOutput,
    );
    run.settled = status;
    const callback = channelCallback(run);
    callback?.({ index: run.channelIndex, end: true });
    run.resolve({
      runId,
      provider: run.request.provider,
      model: run.request.model,
      status,
      ...(structuredOutput ? { structuredOutput } : {}),
      text: summary,
      durationMs: 50,
      commandPath: "/renderer-qa/codex",
      evidence: ["Renderer QA controlled provider"],
      selectionMode: run.request.selectionMode || "fixed",
      billingFallback: false,
    });
    return true;
  };
  const delegationStatus = (targets) => {
    if (targets.every((target) => target.status === "queued")) return "queued";
    if (targets.some((target) => ["queued", "running"].includes(target.status))) return "running";
    if (targets.some((target) => target.status === "awaiting-approval")) return "awaiting-approval";
    if (targets.some((target) => target.status === "completed")) return "completed";
    if (targets.every((target) => target.status === "canceled")) return "canceled";
    return "failed";
  };
  const replaceDelegation = (updated) => {
    const index = delegations.findIndex((candidate) => candidate.id === updated.id);
    if (index >= 0) delegations[index] = updated;
    else delegations.push(updated);
    return clone(updated);
  };

  const readyCodex = {
    id: "codex",
    label: "Codex",
    family: "subscription",
    distribution: "direct-only",
    status: "ready",
    health: "ready",
    canRun: true,
    capabilities: ["app-server", "provider-owned-auth", "structured-output"],
    models: [{
      id: "default",
      label: "Default",
      status: "ready",
      capabilities: ["structured-output"],
      local: false,
      recommended: true,
      detail: "Controlled renderer QA provider",
    }],
    quota: { state: "available", detail: "Controlled renderer QA quota" },
    detail: "Ready through the deterministic renderer fixture.",
  };
  const readyCopilot = {
    ...readyCodex,
    id: "copilot",
    label: "GitHub Copilot",
    health: "unchecked-auth",
    detail: "Installed; GitHub checks subscription sign-in when a run starts.",
  };
  const readyMcpServers = [{
    id: "slack-local",
    name: "Slack",
    transport: "localhost",
    protocolVersion: "2025-06-18",
    serverName: "slack-renderer-qa",
    serverVersion: "1.0.0",
    fingerprint: "c".repeat(64),
    config: {
      transport: "localhost",
      arguments: [],
      endpoint: "http://127.0.0.1:57321/mcp",
      networkAccess: true,
      projectAccess: false,
    },
    tools: [{
      name: "send_message",
      description: "Send one message to an approved Slack channel.",
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Slack channel" },
          text: { type: "string", description: "Message body" },
        },
        required: ["channel", "text"],
        additionalProperties: false,
      },
      schemaSha256: "d".repeat(64),
      effect: "write",
      destructive: false,
      idempotent: false,
      approved: true,
    }],
    detail: "Ready with 1 reviewed tool.",
    enabled: true,
    status: "ready",
    updatedAt: CREATED_AT,
  }];
  const pilotReport = () => ({
    schemaVersion: 1,
    kind: "codelit-local-pilot-report",
    reportId: `report-renderer-${unexpectedActionReports.length}`,
    participantId: "participant-renderer-qa",
    generatedAt: timestamp(),
    app: {
      version: "0.1.2",
      buildChannel: "direct",
      sourceCommit: "a".repeat(40),
      sourceDirty: false,
    },
    measurementWindow: { startedAt: CREATED_AT, endedAt: timestamp() },
    privacy: {
      localOnly: true,
      automaticUpload: false,
      excluded: ["prompt text", "browser content and URLs", "file names and contents", "screenshots", "memories", "credentials", "provider responses and model output", "local database rows"],
    },
    activation: {
      customBotCreated: true,
      firstRunAttempted: true,
      firstRunCompleted: true,
      firstUsefulResultCompleted: true,
      secondsToFirstUsefulResult: 75,
    },
    runs: {
      started: 4,
      completed: 3,
      failed: 1,
      canceled: 0,
      activeDays: 2,
      repeatTaskWithinSevenDays: true,
    },
    delegations: { started: 2, completed: 2, repeated: true },
    routines: { created: 1, enabled: 1, occurrences: 3, completedOccurrences: 2, reused: true },
    approvals: { requested: 2, awaiting: 0, resolved: 2, approved: 2, heldOrDenied: 0 },
    unexpectedActions: {
      total: unexpectedActionReports.length,
      categories: [...new Set(unexpectedActionReports)].sort().map((category) => ({
        category,
        count: unexpectedActionReports.filter((candidate) => candidate === category).length,
      })),
    },
  });

  const commands = {
    bootstrap_local_bots: () => catalog(),
    probe_providers: () => [clone(readyCodex), clone(readyCopilot)],
    probe_provider_api_keys: () => ["openai", "anthropic", "gemini"].map((provider) => ({
      provider,
      account: "default",
      configured: false,
      available: true,
      detail: "No API key is stored in macOS Keychain.",
    })),
    list_local_mcp_servers: () => clone(enableMcp ? readyMcpServers : []),
    probe_desktop_update: () => ({
      channel: "direct",
      status: "current",
      currentVersion: "renderer-qa",
      detail: "Controlled Direct renderer build.",
    }),
    get_local_pilot_report: () => clone(pilotReport()),
    record_local_unexpected_action: ({ category }) => {
      if (!["unexpected-action", "unapproved-write", "sensitive-data", "other"].includes(category)) {
        throw new Error("Renderer QA received an invalid unexpected-action category.");
      }
      unexpectedActionReports.push(category);
      return clone(pilotReport());
    },
    export_local_pilot_report: () => {
      exportedPilotReports.push(pilotReport());
      return "/tmp/Codelit Private Product Report.json";
    },
    probe_computer_use_readiness: () => ({
      available: true,
      accessibility: "granted",
      screenRecording: "granted",
      ready: true,
      detail: "Ready for controlled semantic computer actions.",
      environment: {
        status: "ready",
        session: "unlocked",
        accessibility: true,
        screenRecording: true,
        activeDisplayCount: 2,
        awakeDisplayCount: 2,
        topologySha256: "d".repeat(64),
      },
    }),
    request_computer_use_permission: () => ({
      available: true,
      accessibility: "granted",
      screenRecording: "granted",
      ready: true,
      detail: "Ready for controlled semantic computer actions.",
      environment: {
        status: "ready",
        session: "unlocked",
        accessibility: true,
        screenRecording: true,
        activeDisplayCount: 2,
        awakeDisplayCount: 2,
        topologySha256: "d".repeat(64),
      },
    }),
    list_running_computer_apps: () => [{
      bundleId: "com.apple.Safari",
      name: "Safari",
      active: true,
    }],
    list_computer_app_scopes: ({ botId }) => clone(computerScopes.filter((scope) => scope.botId === botId)),
    save_computer_app_scope: ({ request }) => {
      const app = { bundleId: "com.apple.Safari", name: "Safari" };
      if (request.bundleId !== app.bundleId) throw new Error("Renderer QA app is not open.");
      const now = timestamp();
      const previous = computerScopes.find((scope) => (
        scope.botId === request.botId && scope.bundleId === request.bundleId
      ));
      const saved = {
        botId: request.botId,
        bundleId: request.bundleId,
        appName: app.name,
        access: request.access,
        createdAt: previous?.createdAt || now,
        updatedAt: now,
      };
      const index = computerScopes.findIndex((scope) => (
        scope.botId === request.botId && scope.bundleId === request.bundleId
      ));
      if (index >= 0) computerScopes.splice(index, 1, saved);
      else computerScopes.push(saved);
      return clone(saved);
    },
    delete_computer_app_scope: ({ request }) => {
      const index = computerScopes.findIndex((scope) => (
        scope.botId === request.botId && scope.bundleId === request.bundleId
      ));
      if (index < 0) return false;
      computerScopes.splice(index, 1);
      return true;
    },
    inspect_computer_app: ({ request }) => {
      if (!computerScopes.some((scope) => (
        scope.botId === request.botId && scope.bundleId === request.bundleId
      ))) throw new Error("Renderer QA app is not approved.");
      return {
        bundleId: request.bundleId,
        appName: "Safari",
        truncated: false,
        elements: [{
          role: "AXButton",
          label: "New Tab",
          enabled: true,
          actions: ["press"],
          sensitive: false,
          occurrence: 0,
        }],
      };
    },
    run_computer_action: ({ request, onEvent }) => {
      const inspection = commands.inspect_computer_app({ request });
      const callback = callbacks.get(onEvent.id)?.callback;
      const event = (index, eventType, message) => callback?.({
        index,
        message: {
          runId: request.runId,
          sequence: index + 1,
          eventType,
          provider: "computer",
          model: "Safari",
          message,
          createdAt: timestamp(),
        },
      });
      event(0, "started", "Inspecting Safari");
      event(1, "progress", "Pressing New Tab in Safari");
      event(2, "completed", "Pressed New Tab in Safari.");
      callback?.({ index: 3, end: true });
      computerActions.push(clone(request));
      const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
      return {
        runId: request.runId,
        status: "completed",
        summary: "Pressed New Tab in Safari.",
        before: clone(inspection),
        after: clone(inspection),
        evidence: ["before", "after"].map((phase, index) => ({
          phase,
          mimeType: "image/png",
          dataUrl: pixel,
          sha256: String(index + 1).repeat(64),
          windowId: 42,
          width: 1,
          height: 1,
        })),
        environment: {
          before: {
            status: "ready",
            session: "unlocked",
            accessibility: true,
            screenRecording: true,
            activeDisplayCount: 2,
            awakeDisplayCount: 2,
            topologySha256: "d".repeat(64),
          },
          after: {
            status: "ready",
            session: "unlocked",
            accessibility: true,
            screenRecording: true,
            activeDisplayCount: 2,
            awakeDisplayCount: 2,
            topologySha256: "d".repeat(64),
          },
          continuity: "continuous",
        },
      };
    },
    take_over_computer_run: ({ runId, request }) => {
      computerTakeOvers.push({ runId, ...clone(request) });
      return false;
    },
    create_local_bot: ({ request }) => {
      const bot = createBot(
        request.id,
        request.name,
        request.job,
        request.createdAt,
        request.avatar,
      );
      bots.unshift(bot);
      workspaces.set(bot.threadId, createWorkspace(bot));
      activeBotId = bot.id;
      return catalog();
    },
    set_active_local_bot: ({ id }) => {
      findBot(id);
      activeBotId = id;
      return catalog();
    },
    choose_workspace_folder: () => {
      const workspace = findWorkspace(findBot(activeBotId).threadId);
      workspace.workspaceFolder = {
        path: "/Users/qa/Codelit Project",
        readOnly: true,
        stale: false,
        accessValidated: true,
        updatedAt: timestamp(),
      };
      return clone(workspace);
    },
    update_local_bot_status: ({ request }) => replaceBot(request.id, (bot) => ({
      ...bot,
      status: request.status,
      latestStatus: request.latestStatus,
      updatedAt: request.updatedAt,
    })),
    update_local_bot_approval_mode: ({ request }) => replaceBot(request.id, (bot) => ({
      ...bot,
      currentVersion: bot.currentVersion + 1,
      spec: {
        ...bot.spec,
        version: bot.currentVersion + 1,
        permissionPolicy: {
          ...bot.spec.permissionPolicy,
          approvalMode: request.approvalMode,
        },
        updatedAt: request.updatedAt,
      },
      updatedAt: request.updatedAt,
    })),
    update_local_bot_browser_domains: ({ request }) => replaceBot(request.id, (bot) => {
      if (request.expectedVersion !== undefined && bot.currentVersion !== request.expectedVersion) {
        throw new Error("That bot changed before this update. Review it and try again.");
      }
      const version = bot.currentVersion + 1;
      return {
        ...bot,
        currentVersion: version,
        spec: {
          ...bot.spec,
          version,
          permissionPolicy: {
            ...bot.spec.permissionPolicy,
            browserDomains: [...new Set(request.domains)],
          },
          updatedAt: request.updatedAt,
        },
        updatedAt: request.updatedAt,
      };
    }),
    update_local_bot_goal: ({ request }) => replaceBot(request.id, (bot) => {
      if (request.expectedVersion !== undefined && bot.currentVersion !== request.expectedVersion) {
        throw new Error("That bot changed before this update. Review it and try again.");
      }
      const version = bot.currentVersion + 1;
      return {
        ...bot,
        currentVersion: version,
        spec: {
          ...bot.spec,
          version,
          goal: clone(request.goal),
          updatedAt: request.updatedAt,
        },
        updatedAt: request.updatedAt,
      };
    }),
    update_local_bot_routines: ({ request }) => replaceBot(request.id, (bot) => {
      const version = bot.currentVersion + 1;
      const allowBackground = request.allowBackground && request.routineIds.length > 0;
      return {
        ...bot,
        currentVersion: version,
        spec: {
          ...bot.spec,
          version,
          routineIds: [...request.routineIds],
          autonomyPolicy: {
            ...bot.spec.autonomyPolicy,
            mode: allowBackground ? "reviewed-routines" : "manual",
            allowBackground,
          },
          updatedAt: request.updatedAt,
        },
        updatedAt: request.updatedAt,
      };
    }),
    open_local_bot_context: ({ id }) => {
      const bot = findBot(id);
      return { bot: clone(bot), workspace: clone(findWorkspace(bot.threadId)) };
    },
    list_local_bot_tables: ({ botId }) => clone(botTables
      .filter((table) => table.botId === botId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))),
    create_local_bot_table: ({ request }) => {
      findBot(request.botId);
      if (botTables.some((table) => table.botId === request.botId
        && table.name.toLowerCase() === request.name.trim().toLowerCase())) {
        throw new Error("This bot already has a table with that name.");
      }
      const table = {
        id: request.id,
        databaseId: `bot-database:${request.botId}`,
        botId: request.botId,
        name: request.name.trim(),
        version: 1,
        columns: clone(request.columns),
        rowCount: 0,
        createdAt: request.createdAt,
        updatedAt: request.createdAt,
      };
      botTables.push(table);
      botTableRows.set(table.id, []);
      return botTableView(table);
    },
    append_local_bot_table_row: ({ request }) => {
      const table = botTables.find((candidate) => candidate.id === request.tableId
        && candidate.botId === request.botId);
      if (!table) throw new Error("That local table is no longer available to this bot.");
      const rows = botTableRows.get(table.id) || [];
      const values = Object.fromEntries(table.columns.map((column) => [
        column.name,
        Object.entries(request.values).find(([name]) => name.toLowerCase() === column.name.toLowerCase())?.[1] ?? null,
      ]));
      rows.push({
        id: request.id,
        values,
        createdAt: request.createdAt,
        updatedAt: request.createdAt,
      });
      botTableRows.set(table.id, rows);
      table.rowCount = rows.length;
      table.updatedAt = request.createdAt;
      return botTableView(table);
    },
    open_local_bot_table: ({ botId, tableId, limit }) => {
      const table = botTables.find((candidate) => candidate.id === tableId && candidate.botId === botId);
      if (!table) throw new Error("That local table is no longer available to this bot.");
      return botTableView(table, limit);
    },
    export_local_bot_table_csv: ({ botId, tableId }) => {
      const table = botTables.find((candidate) => candidate.id === tableId && candidate.botId === botId);
      if (!table) throw new Error("That local table is no longer available to this bot.");
      exportedBotTables.push({ botId, tableId });
      const name = table.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      return `/Users/qa/${name || "codelit-table"}.csv`;
    },
    list_quarantined_browser_downloads: ({ botId }) => clone(quarantinedBrowserDownloads
      .filter((download) => download.botId === botId)
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt))),
    release_quarantined_browser_download: ({ botId, downloadId }) => {
      const index = quarantinedBrowserDownloads.findIndex((download) => (
        download.id === downloadId && download.botId === botId
      ));
      if (index < 0) throw new Error("That quarantined download is no longer available.");
      const [download] = quarantinedBrowserDownloads.splice(index, 1);
      releasedBrowserDownloads.push({ botId, downloadId, fileName: download.fileName });
      return `/Users/qa/Downloads/${download.fileName}`;
    },
    delete_quarantined_browser_download: ({ botId, downloadId }) => {
      const index = quarantinedBrowserDownloads.findIndex((download) => (
        download.id === downloadId && download.botId === botId
      ));
      if (index < 0) throw new Error("That quarantined download is no longer available.");
      quarantinedBrowserDownloads.splice(index, 1);
      return null;
    },
    list_local_bot_group_members: ({ ownerBotId }) => clone(
      (groupMembers.get(ownerBotId) || []).map((id) => findBot(id)),
    ),
    update_local_bot_group_members: ({ request }) => {
      if (request.memberBotIds.length > 2) {
        throw new Error("Keep one or two specialist bots in a conversation.");
      }
      findBot(request.ownerBotId);
      const unique = new Set(request.memberBotIds);
      if (unique.size !== request.memberBotIds.length || unique.has(request.ownerBotId)) {
        throw new Error("Choose one or two different specialist bots.");
      }
      const members = request.memberBotIds.map((id) => findBot(id));
      groupMembers.set(request.ownerBotId, [...request.memberBotIds]);
      return clone(members);
    },
    list_local_bot_delegations: ({ parentBotId }) => clone(delegations
      .filter((delegation) => !parentBotId || delegation.parentBotId === parentBotId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))),
    recover_local_bot_delegations: () => {
      const recoveredAt = timestamp();
      for (const delegation of [...delegations]) {
        const targets = delegation.targets.map((target) => target.status === "running"
          ? {
              ...target,
              status: "failed",
              detail: "Codelit closed before this specialist finished. Ask the bot again to retry.",
              completedAt: recoveredAt,
              updatedAt: recoveredAt,
            }
          : target);
        if (targets.some((target, index) => target !== delegation.targets[index])) {
          replaceDelegation({
            ...delegation,
            targets,
            status: delegationStatus(targets),
            updatedAt: recoveredAt,
          });
        }
      }
      return clone(delegations.sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
    },
    create_local_bot_delegation: ({ request }) => {
      const parent = findBot(request.parentBotId);
      const targets = request.targetBotIds.map((id) => findBot(id));
      return replaceDelegation({
        id: request.id,
        parentBotId: parent.id,
        parentThreadId: parent.threadId,
        parentBotName: parent.name,
        parentBotVersion: parent.currentVersion,
        task: request.task.trim(),
        expectedOutput: request.expectedOutput.trim(),
        sharedMemorySnapshotHash: request.sharedMemorySnapshotHash,
        status: "queued",
        maxParallel: targets.length,
        targets: targets.map((target) => ({
          botId: target.id,
          threadId: target.threadId,
          botName: target.name,
          botVersion: target.currentVersion,
          status: "queued",
          maxActions: request.maxActions,
          deadlineAt: request.deadlineAt,
          botSnapshot: clone(target.spec),
          updatedAt: request.createdAt,
        })),
        createdAt: request.createdAt,
        updatedAt: request.createdAt,
      });
    },
    start_local_bot_delegation_target: ({ request }) => {
      const delegation = delegations.find((candidate) => candidate.id === request.id);
      if (!delegation) throw new Error("Renderer QA delegation not found.");
      const targets = delegation.targets.map((target) => target.botId === request.targetBotId
        ? {
            ...target,
            status: "running",
            runId: request.runId,
            providerId: request.providerId,
            detail: undefined,
            updatedAt: request.startedAt,
          }
        : target);
      return replaceDelegation({
        ...delegation,
        targets,
        status: delegationStatus(targets),
        updatedAt: request.startedAt,
      });
    },
    finish_local_bot_delegation_target: ({ request }) => {
      const delegation = delegations.find((candidate) => candidate.id === request.id);
      if (!delegation) throw new Error("Renderer QA delegation not found.");
      const status = request.outcome === "approval-required" ? "awaiting-approval" : request.outcome;
      const targets = delegation.targets.map((target) => target.botId === request.targetBotId
        ? {
            ...target,
            status,
            ...(request.result ? { result: request.result } : {}),
            ...(request.detail ? { detail: request.detail } : {}),
            ...(status === "awaiting-approval" ? {} : { completedAt: request.finishedAt }),
            updatedAt: request.finishedAt,
          }
        : target);
      return replaceDelegation({
        ...delegation,
        targets,
        status: delegationStatus(targets),
        updatedAt: request.finishedAt,
      });
    },
    cancel_local_bot_delegation: ({ id }) => {
      const delegation = delegations.find((candidate) => candidate.id === id);
      if (!delegation) throw new Error("Renderer QA delegation not found.");
      const canceledAt = timestamp();
      const targets = delegation.targets.map((target) => ["queued", "running", "awaiting-approval"].includes(target.status)
        ? { ...target, status: "canceled", completedAt: canceledAt, updatedAt: canceledAt }
        : target);
      return replaceDelegation({
        ...delegation,
        targets,
        status: delegationStatus(targets),
        updatedAt: canceledAt,
      });
    },
    list_local_bot_memories: ({ botId }) => clone(memories
      .filter((memory) => memory.botId === botId || memory.scope === "workspace")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))),
    save_local_bot_memory: ({ request }) => {
      if (memories.some((memory) => memory.id === request.id)) {
        throw new Error("That memory already exists.");
      }
      const memory = {
        id: request.id,
        ...(request.scope === "bot" ? { botId: request.actorBotId } : {}),
        scope: request.scope,
        kind: request.kind,
        body: request.body.trim(),
        source: "user",
        confidence: 1,
        sensitivity: "normal",
        approvalState: "approved",
        ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
        createdAt: request.createdAt,
        updatedAt: request.createdAt,
      };
      memories.push(memory);
      return clone(memory);
    },
    list_local_bot_memory_proposals: ({ botId }) => clone(memoryProposals
      .filter((proposal) => proposal.botId === botId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))),
    create_local_bot_memory_proposal: ({ request }) => {
      const duplicate = memories.some((memory) => (memory.botId === request.actorBotId
        || memory.scope === "workspace") && memory.body.toLowerCase() === request.body.trim().toLowerCase())
        || memoryProposals.some((proposal) => proposal.botId === request.actorBotId
          && proposal.body.toLowerCase() === request.body.trim().toLowerCase());
      if (duplicate || memoryProposals.filter((proposal) => proposal.botId === request.actorBotId).length >= 3) {
        return null;
      }
      const proposal = {
        id: request.id,
        botId: request.actorBotId,
        scope: "bot",
        kind: request.kind,
        body: request.body.trim(),
        source: "inferred",
        confidence: 0.86,
        sensitivity: "normal",
        approvalState: "pending",
        sourceRunId: request.sourceRunId,
        createdAt: request.createdAt,
        updatedAt: request.createdAt,
      };
      memoryProposals.push(proposal);
      return clone(proposal);
    },
    review_local_bot_memory_proposal: ({ request }) => {
      const index = memoryProposals.findIndex((proposal) => proposal.id === request.id
        && proposal.botId === request.actorBotId);
      if (index < 0) throw new Error("That memory suggestion is no longer waiting for review.");
      const [proposal] = memoryProposals.splice(index, 1);
      if (request.decision === "dismiss") return null;
      const memory = {
        id: `memory-reviewed-${proposal.id.replace(/^memory-proposal-/, "")}`,
        ...(request.scope === "bot" ? { botId: request.actorBotId } : {}),
        scope: request.scope,
        kind: proposal.kind,
        body: proposal.body,
        source: "inferred",
        confidence: proposal.confidence,
        sensitivity: "normal",
        approvalState: "approved",
        sourceRunId: proposal.sourceRunId,
        ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
        createdAt: request.reviewedAt,
        updatedAt: request.reviewedAt,
      };
      memories.push(memory);
      return clone(memory);
    },
    delete_local_bot_memory: ({ request }) => {
      const index = memories.findIndex((memory) => memory.id === request.id
        && (memory.botId === request.actorBotId || memory.scope === "workspace"));
      if (index < 0) throw new Error("That memory is no longer available to this bot.");
      const [memory] = memories.splice(index, 1);
      return clone(memory);
    },
    clear_local_bot_memories: ({ request }) => {
      const visible = memories.filter((memory) => memory.botId === request.actorBotId
        || (request.includeShared && memory.scope === "workspace"));
      for (const memory of visible) memories.splice(memories.indexOf(memory), 1);
      const proposals = memoryProposals.filter((proposal) => proposal.botId === request.actorBotId);
      for (const proposal of proposals) memoryProposals.splice(memoryProposals.indexOf(proposal), 1);
      return visible.length + proposals.length;
    },
    list_local_bot_skills: () => clone(skills
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))),
    save_local_bot_skill: ({ request }) => {
      const existingIndex = skills.findIndex((skill) => skill.id === request.id);
      const existing = existingIndex >= 0 ? skills[existingIndex] : null;
      if (existing && request.expectedVersion !== existing.version) {
        throw new Error("This skill changed before your update was saved. Review it and try again.");
      }
      if (skills.some((skill) => skill.id !== request.id
        && skill.name.toLowerCase() === request.name.trim().toLowerCase())) {
        throw new Error("A reusable skill with that name already exists.");
      }
      const skill = {
        id: request.id,
        version: existing ? existing.version + 1 : 1,
        name: request.name.trim(),
        description: request.description.trim(),
        instructions: request.instructions.trim(),
        capabilityIds: [...request.capabilityIds],
        inputSchema: clone(request.inputSchema || []),
        outputSchema: clone(request.outputSchema || []),
        requiredPermissions: [...(request.requiredPermissions || [])],
        effects: clone(request.effects || []),
        examples: clone(request.examples || []),
        checks: clone(request.checks || []),
        source: "taught",
        trustState: "reviewed",
        checksum: "a".repeat(64),
        createdAt: existing?.createdAt || request.createdAt,
        updatedAt: request.createdAt,
      };
      if (existingIndex >= 0) skills.splice(existingIndex, 1, skill);
      else skills.push(skill);
      return clone(skill);
    },
    import_local_bot_skill: () => {
      const skill = {
        id: "skill-imported-issue-brief",
        version: 1,
        name: "Issue brief",
        description: "Turn one bounded issue into a concise local brief.",
        instructions: "Use only the supplied issue text and return one next action.",
        capabilityIds: ["conversation"],
        inputSchema: [{ id: "issue", label: "Issue", type: "text", required: true }],
        outputSchema: [{ id: "brief", label: "Issue brief", type: "text", required: true }],
        requiredPermissions: [],
        effects: [{
          id: "write-brief",
          label: "Generate a local brief",
          kind: "model-generate",
          target: "conversation",
          risk: "local",
        }],
        examples: [{ request: "Run Issue brief with issue: Slow first launch" }],
        checks: [
          { id: "issue", label: "Issue is present", phase: "before", rule: "required", inputId: "issue" },
          { id: "brief", label: "Issue brief is present", phase: "after", rule: "output-present" },
        ],
        source: "imported",
        trustState: "unreviewed",
        checksum: "c".repeat(64),
        createdAt: "2026-08-20T08:00:00.000Z",
        updatedAt: "2026-08-20T08:00:00.000Z",
      };
      skills.push(skill);
      return clone(skill);
    },
    review_imported_bot_skill: ({ request }) => {
      const index = skills.findIndex((skill) => skill.id === request.id);
      if (index < 0) throw new Error("That imported skill is no longer waiting for review.");
      const skill = skills[index];
      if (skill.source !== "imported"
        || skill.trustState !== "unreviewed"
        || skill.version !== request.expectedVersion) {
        throw new Error("This imported skill changed before it was reviewed.");
      }
      if (request.decision === "discard") {
        skills.splice(index, 1);
        return null;
      }
      const approved = {
        ...skill,
        version: skill.version + 1,
        trustState: "reviewed",
        checksum: "d".repeat(64),
        updatedAt: request.reviewedAt,
      };
      skills.splice(index, 1, approved);
      return clone(approved);
    },
    delete_local_bot_skill: ({ request }) => {
      const index = skills.findIndex((skill) => skill.id === request.id);
      if (index < 0) throw new Error("That reusable skill is no longer available.");
      if (skills[index].source === "built-in") {
        throw new Error("Packaged Codelit skills stay available with the app.");
      }
      const [skill] = skills.splice(index, 1);
      return clone(skill);
    },
    update_local_bot_profile: ({ request }) => {
      profileUpdates.push(clone(request));
      const updated = replaceBot(request.id, (bot) => {
        const version = bot.currentVersion + 1;
        const avatar = request.avatar || bot.spec.appearance?.avatar || {
          kind: "preset",
          preset: "spark",
        };
        return {
          ...bot,
          currentVersion: version,
          name: request.name,
          spec: {
            ...bot.spec,
            version,
            name: request.name,
            appearance: { avatar },
            updatedAt: request.updatedAt,
          },
          updatedAt: request.updatedAt,
        };
      });
      const workspace = findWorkspace(updated.threadId);
      workspace.thread.title = updated.name;
      workspace.thread.updatedAt = request.updatedAt;
      return updated;
    },
    list_local_schedules: () => clone(schedules),
    list_local_event_routines: () => clone(eventRoutines),
    probe_background_service: () => ({
      status: "enabled",
      bundled: true,
      detail: "Controlled renderer QA background service.",
    }),
    set_background_work_enabled: () => ({
      status: "enabled",
      bundled: true,
      detail: "Controlled renderer QA background service.",
    }),
    open_background_work_settings: () => null,
    get_bot_autonomy_policy: ({ timezone }) => {
      autonomyPolicy = { ...autonomyPolicy, timezone };
      return clone(autonomyPolicy);
    },
    update_bot_autonomy_policy: ({ request }) => {
      autonomyPolicy = {
        ...autonomyPolicy,
        ...clone(request),
        status: request.globallyPaused ? "paused" : "active",
        statusDetail: request.globallyPaused ? "All routines are paused" : "Routines are active",
        canStartWork: !request.globallyPaused,
        updatedAt: timestamp(),
      };
      return clone(autonomyPolicy);
    },
    deliver_due_daily_digest: () => null,
    list_recent_routine_activity: () => ([{
      id: "activity-release-check",
      botId: "bot-alpha",
      botName: "Alpha",
      routineId: "routine-release-check",
      title: "Morning release check",
      triggerKind: "schedule",
      status: "completed",
      runId: "scheduled-activity-release-check",
      occurredAt: "2026-08-19T15:05:00.000Z",
    }]),
    save_local_schedule: ({ request }) => {
      const current = schedules.find((candidate) => candidate.id === request.id);
      if (request.expectedRevision !== undefined && current?.revision !== request.expectedRevision) {
        throw new Error("That routine changed before this update. Review it and try again.");
      }
      const now = timestamp();
      const saved = {
        ...clone(request),
        expectedRevision: undefined,
        revision: (current?.revision || 0) + 1,
        ...(request.enabled ? { nextDueAt: "2026-08-20T14:00:00.000Z" } : {}),
        createdAt: current?.createdAt || now,
        updatedAt: now,
      };
      const index = schedules.findIndex((candidate) => candidate.id === request.id);
      if (index >= 0) schedules[index] = saved;
      else schedules.push(saved);
      return clone(saved);
    },
    set_local_schedule_enabled: ({ request }) => {
      const index = schedules.findIndex((candidate) => candidate.id === request.id);
      if (index < 0) throw new Error(`Renderer QA schedule not found: ${request.id}`);
      schedules[index] = {
        ...schedules[index],
        enabled: request.enabled,
        pausedReason: undefined,
        ...(request.enabled ? { nextDueAt: "2026-08-20T14:00:00.000Z" } : { nextDueAt: undefined }),
        revision: schedules[index].revision + 1,
        updatedAt: timestamp(),
      };
      return clone(schedules[index]);
    },
    delete_local_schedule: ({ id }) => {
      const index = schedules.findIndex((candidate) => candidate.id === id);
      if (index >= 0) schedules.splice(index, 1);
      return null;
    },
    save_local_event_routine: ({ request }) => {
      const bot = findBot(request.botId);
      const saved = {
        ...clone(request),
        version: 1,
        threadId: bot.threadId,
        enabled: false,
        createdAt: request.createdAt,
        updatedAt: request.createdAt,
      };
      eventRoutines.push(saved);
      return clone(saved);
    },
    set_local_event_routine_enabled: ({ request }) => {
      const index = eventRoutines.findIndex((candidate) => candidate.id === request.id);
      if (index < 0) throw new Error(`Renderer QA event routine not found: ${request.id}`);
      eventRoutines[index] = {
        ...eventRoutines[index],
        enabled: request.enabled,
        pausedReason: undefined,
        ...(request.enabled && request.fingerprint ? {
          lastCheckedAt: request.fingerprint.capturedAt,
          lastFileCount: request.fingerprint.fileCount,
          lastTruncated: request.fingerprint.truncated,
        } : {}),
        updatedAt: timestamp(),
      };
      return clone(eventRoutines[index]);
    },
    delete_local_event_routine: ({ id }) => {
      const index = eventRoutines.findIndex((candidate) => candidate.id === id);
      if (index >= 0) eventRoutines.splice(index, 1);
      return null;
    },
    read_local_project_fingerprint: () => ({
      sha256: "b".repeat(64),
      fileCount: 148,
      truncated: false,
      capturedAt: timestamp(),
    }),
    claim_changed_event_routines: () => [],
    mark_event_routine_occurrence_running: () => null,
    renew_event_routine_occurrence_lease: () => null,
    finish_event_routine_occurrence: () => null,
    event_routine_execution_permitted: () => true,
    claim_due_local_schedules: () => [],
    take_opened_local_notification: () => null,
    consume_local_notification: () => null,
    show_local_notification: ({ request }) => ({ id: `notification-${request.runId}`, ...request }),
    prepare_local_tool_approval: ({ request }) => {
      const mcpReference = request.tools?.length === 1 && request.tools[0]?.startsWith("mcp::")
        ? request.tools[0]
        : null;
      if (mcpReference) {
        const args = request.toolInputs?.[mcpReference];
        if (mcpReference !== "mcp::slack-local::send_message"
          || !args
          || typeof args.channel !== "string"
          || typeof args.text !== "string") {
          throw new Error("Renderer QA expected one exact typed Slack MCP approval.");
        }
        const approvalSha256 = (mcpApprovals.length + 1).toString(16).padStart(64, "c");
        const evidence = [
          `Slack / send_message\nEffect: write\nArguments:\n${JSON.stringify(args, null, 2)}`,
        ];
        preparedMcpApprovals.set(request.runId, {
          approvalSha256,
          toolReference: mcpReference,
          arguments: clone(args),
        });
        mcpApprovals.push({
          runId: request.runId,
          approvalSha256,
          toolReference: mcpReference,
          arguments: clone(args),
        });
        return {
          runId: request.runId,
          status: "ready",
          summary: "Review 1 exact local MCP call before any server receives data.",
          evidence,
          approvalSha256,
        };
      }
      const action = request.toolInputs?.["Browser act"];
      if (!action || request.tools?.length !== 1 || request.tools[0] !== "Browser act") {
        throw new Error("Renderer QA expected one exact Browser act approval.");
      }
      const approvalSha256 = (browserApprovals.length + 1).toString(16).padStart(64, "a");
      const valueLength = typeof action.value === "string" ? action.value.length : 0;
      const evidence = [
        `Browser act\nMode: action\nURL: ${action.url}\nExact action: ${action.action}\nExact target: ${action.target}`
          + (valueLength ? `\nTyped value: ${valueLength} characters; content is omitted` : ""),
      ];
      preparedBrowserApprovals.set(request.runId, {
        approvalSha256,
        toolInputs: clone(request.toolInputs),
      });
      browserApprovals.push({
        runId: request.runId,
        approvalSha256,
        action: action.action,
        target: action.target,
        valueLength,
        evidence,
      });
      return {
        runId: request.runId,
        status: "ready",
        summary: "1 exact browser action ready for review",
        evidence,
        approvalSha256,
      };
    },
    discard_prepared_local_tool_approval: ({ runId }) => {
      preparedBrowserApprovals.delete(runId);
      preparedMcpApprovals.delete(runId);
      return null;
    },
    run_local_tool_batch: ({ request }) => {
      const mcpReference = request.tools?.length === 1 && request.tools[0]?.startsWith("mcp::")
        ? request.tools[0]
        : null;
      if (mcpReference) {
        const prepared = preparedMcpApprovals.get(request.runId);
        if (!prepared
          || prepared.toolReference !== mcpReference
          || prepared.approvalSha256 !== request.approvalSha256
          || Object.keys(request.toolInputs || {}).length > 0) {
          throw new Error("Renderer QA MCP call did not match its exact approval.");
        }
        preparedMcpApprovals.delete(request.runId);
        mcpActions.push({
          runId: request.runId,
          approvalSha256: request.approvalSha256,
          toolReference: mcpReference,
          arguments: clone(prepared.arguments),
        });
        return {
          runId: request.runId,
          status: "completed",
          context: [JSON.stringify({
            ok: true,
            channel: prepared.arguments.channel,
            messageId: "renderer-qa-message-1",
          })],
          completedTools: [{ toolId: mcpReference, toolName: "Slack / send_message" }],
          failure: null,
          browserProofs: [],
        };
      }
      if (request.tools?.length === 1 && request.tools[0] === "Browser act") {
        const prepared = preparedBrowserApprovals.get(request.runId);
        const suppliedInputs = request.toolInputs || {};
        if (!prepared
          || prepared.approvalSha256 !== request.approvalSha256
          || (Object.keys(suppliedInputs).length > 0
            && JSON.stringify(prepared.toolInputs) !== JSON.stringify(suppliedInputs))) {
          throw new Error("Renderer QA browser action did not match its exact approval.");
        }
        const action = prepared.toolInputs["Browser act"];
        preparedBrowserApprovals.delete(request.runId);
        if (typeof action.value === "string") browserActionRuntimeValues.push(action.value);
        browserActions.push({
          runId: request.runId,
          action: action.action,
          target: action.target,
          url: action.url,
          valueLength: typeof action.value === "string" ? action.value.length : 0,
          approvalSha256: request.approvalSha256,
        });
        const actionIndex = browserActions.length;
        const download = action.action === "download" ? {
          id: `download-${actionIndex}`,
          botId: request.browserProjectId,
          sessionId: request.browserSessionId,
          fileName: "release-report.pdf",
          sourceUrl: action.url,
          byteSize: 24_832,
          sha256: actionIndex.toString(16).padStart(64, "b"),
          createdAt: timestamp(),
          completedAt: timestamp(),
        } : null;
        if (download) quarantinedBrowserDownloads.push(download);
        return {
          runId: request.runId,
          status: "completed",
          context: [download
            ? `${download.fileName} is quarantined; contents unavailable until release.`
            : `Browser act ${actionIndex} completed; typed values omitted.`],
          completedTools: [{ toolId: "browser-act", toolName: "Browser act" }],
          failure: null,
          browserProofs: [{
            toolId: "browser-act",
            auditId: `browser-proof-${actionIndex}`,
            mode: "write",
            evidence: [
              { id: `browser-dom-${actionIndex}`, type: "dom" },
              ...(download ? [{ id: download.sha256, type: "quarantined-file" }] : []),
            ],
            attempts: 1,
            events: [{ action: action.action, attempt: 1, status: "completed" }],
          }],
        };
      }
      return {
        runId: request.runId,
        status: "completed",
        context: ["Renderer QA project context"],
        completedTools: [{ toolId: "selected-folder", toolName: "Selected folder" }],
        failure: null,
        browserProofs: [],
      };
    },
    open_local_browser: ({ request }) => {
      const session = {
        sessionId: request.sessionId,
        projectId: request.projectId,
        status: "ready",
        visible: true,
        currentUrl: request.url,
        allowedDomains: [...request.allowedDomains],
        downloadArmed: false,
        events: [],
      };
      browserSessions.set(request.sessionId, session);
      return clone(session);
    },
    resize_local_browser: ({ request }) => clone(browserSessions.get(request.sessionId)),
    set_local_browser_visibility: ({ request }) => {
      const session = browserSessions.get(request.sessionId);
      if (!session) throw new Error("Renderer QA browser was closed.");
      session.visible = request.visible;
      return clone(session);
    },
    close_local_browser: ({ request }) => {
      browserSessions.delete(request.sessionId);
      browserTeachings.delete(request.sessionId);
      return null;
    },
    start_local_browser_teaching: ({ request }) => {
      const session = browserSessions.get(request.sessionId);
      if (!session) throw new Error("Renderer QA browser was not opened.");
      const teaching = {
        sessionId: request.sessionId,
        status: "recording",
        startUrl: session.currentUrl,
        currentUrl: session.currentUrl,
        approvedDomains: [...session.allowedDomains],
        events: [{ type: "navigate", url: session.currentUrl, risk: "none" }],
        startedAt: timestamp(),
      };
      browserTeachings.set(request.sessionId, teaching);
      return clone(teaching);
    },
    capture_local_browser_teaching: ({ request }) => {
      const teaching = browserTeachings.get(request.sessionId);
      if (!teaching) throw new Error("Renderer QA teaching was not started.");
      if (teaching.events.length === 1) {
        teaching.events.push(
          {
            type: "fill",
            url: teaching.startUrl,
            target: {
              expression: '[aria-label="Customer email"]',
              label: "Customer email",
              tag: "input",
              inputType: "email",
            },
            risk: "none",
          },
          {
            type: "click",
            url: teaching.startUrl,
            target: {
              expression: "text:Search",
              label: "Search",
              tag: "button",
              inputType: "submit",
            },
            risk: "none",
          },
          {
            type: "fill",
            url: teaching.startUrl,
            target: {
              expression: "",
              label: "Identity control",
              tag: "input",
              inputType: "password",
            },
            risk: "login",
          },
        );
      }
      return clone(teaching);
    },
    finish_local_browser_teaching: ({ request }) => {
      const teaching = commands.capture_local_browser_teaching({ request });
      teaching.status = "review";
      browserTeachings.set(request.sessionId, clone(teaching));
      return teaching;
    },
    dry_run_local_browser_teaching: ({ request }) => {
      if (!browserTeachings.has(request.sessionId)) throw new Error("Renderer QA teaching was not reviewed.");
      return {
        passed: true,
        executableSteps: 2,
        protectedSteps: 1,
        checks: [
          { id: "boundary", label: "Approved website boundary", passed: true, detail: "Inside boundary" },
          { id: "values", label: "No typed values retained", passed: true, detail: "No values retained" },
          { id: "targets", label: "Visible replay targets", passed: true, detail: "Two targets verified; one protected step held for takeover" },
        ],
      };
    },
    "plugin:event|listen": () => 1,
    "plugin:event|unlisten": () => null,
    append_thread_message: ({ request }) => {
      const workspace = findWorkspace(request.threadId);
      appendBlock(workspace, {
        id: request.id,
        createdAt: request.createdAt,
        type: request.role === "assistant" ? "assistant-message" : "user-message",
        text: request.text.trim(),
      });
      return clone(workspace);
    },
    begin_local_run: ({ request }) => {
      const workspace = findWorkspace(request.threadId);
      runOwners.set(request.runId, { threadId: request.threadId, botId: findBot(
        bots.find((bot) => bot.threadId === request.threadId)?.id || "",
      ).id });
      workspace.thread.status = "working";
      workspace.thread.activeRunRef = request.runId;
      workspace.thread.updatedAt = request.createdAt;
      workspace.runEvents.push({
        runId: request.runId,
        sequence: 1,
        eventType: "run.queued",
        payload: { status: "running", provider: request.provider, model: request.model },
        createdAt: request.createdAt,
      });
      return clone(workspace);
    },
    save_run_checkpoint: ({ request }) => {
      const owner = ownerForRun(request.runId);
      const workspace = findWorkspace(owner.threadId);
      workspace.runCheckpoints = [
        ...workspace.runCheckpoints.filter((checkpoint) => checkpoint.runId !== request.runId),
        {
          runId: request.runId,
          stepIndex: request.stepIndex,
          body: clone(request),
          updatedAt: request.updatedAt,
        },
      ];
      return clone(workspace);
    },
    record_run_approval: ({ request }) => {
      const owner = runOwners.get(request.runId)
        || { botId: request.body.botId, threadId: findBot(request.body.botId).threadId };
      runOwners.set(request.runId, owner);
      const workspace = findWorkspace(owner.threadId);
      const previous = workspace.approvals.find((approval) => approval.id === request.id);
      workspace.approvals = [
        ...workspace.approvals.filter((approval) => approval.id !== request.id),
        {
          id: request.id,
          runId: request.runId,
          stepIndex: request.stepIndex,
          status: request.status,
          body: clone(request.body),
          createdAt: previous?.createdAt || request.updatedAt,
          updatedAt: request.updatedAt,
        },
      ];
      workspace.thread.status = request.status === "awaiting"
        ? "needs-input"
        : request.status === "approved"
          ? "working"
          : "failed";
      workspace.thread.activeRunRef = request.runId;
      workspace.thread.updatedAt = request.updatedAt;
      approvalDecisions.push({
        approvalId: request.id,
        runId: request.runId,
        botId: owner.botId,
        status: request.status,
      });
      return clone(workspace);
    },
    record_local_check: ({ request }) => {
      const owner = ownerForRun(request.runId);
      const workspace = findWorkspace(owner.threadId);
      const createdAt = request.createdAt;
      const status = request.status || "completed";
      const runStatus = status === "completed" ? "completed" : "stopped";
      appendBlock(workspace, {
        id: `block-${request.runId}`,
        createdAt,
        type: "run",
        runId: request.runId,
        label: `${request.provider} local run`,
        detail: request.summary,
        status: runStatus,
      });
      appendBlock(workspace, {
        id: `block-receipt-${request.runId}`,
        createdAt,
        type: "receipt",
        artifact: {
          kind: "receipt",
          id: "artifact-receipt-local",
          version: request.runId,
          projectId: "local-project",
          title: "Local run receipt",
          editorHref: "/local/receipt/artifact-receipt-local",
          createdAt,
        },
        summary: `${request.provider} produced a local receipt with no billing fallback.`,
      });
      workspace.receipts.push({
        id: `receipt-${request.runId}`,
        runId: request.runId,
        artifactId: request.artifactId,
        body: {
          status,
          provider: request.provider,
          model: request.model,
          selectionMode: request.selectionMode,
          eventCount: request.events.length,
          meteredFallbackAuthorized: request.meteredFallbackAuthorized,
          meteredProviderInvocationStarted: request.meteredProviderInvocationStarted,
          billingFallback: request.billingFallback,
          details: clone(request.receiptDetails || {}),
        },
        createdAt,
      });
      workspace.thread.status = status === "completed" ? "completed" : "failed";
      workspace.thread.activeRunRef = request.runId;
      workspace.thread.updatedAt = createdAt;
      replaceBot(owner.botId, (bot) => ({
        ...bot,
        status: status === "completed" ? "done" : "paused",
        latestStatus: status === "completed" ? `Finished with ${request.provider}` : request.summary,
        updatedAt: createdAt,
      }));
      return clone(workspace);
    },
    run_provider_task_stream: ({ request, onEvent }) => new Promise((resolve) => {
      if (providerRuns.get(request.runId)?.settled === null) {
        throw new Error(`Duplicate active renderer QA run: ${request.runId}`);
      }
      const attempt = (providerRuns.get(request.runId)?.attempt || 0) + 1;
      providerRuns.set(request.runId, {
        request: clone(request),
        channel: onEvent,
        resolve,
        attempt,
        eventSequence: 0,
        channelIndex: 0,
        settled: null,
      });
      emitProviderEvent(request.runId, "queued", "Renderer QA run queued");
      emitProviderEvent(request.runId, "started", "Renderer QA provider started");
    }),
    cancel_provider_task: ({ runId }) => {
      cancelCalls.push(runId);
      const run = providerRuns.get(runId);
      if (!run || run.settled) return false;
      settleProviderRun(runId, "canceled", "The local run was canceled.");
      return true;
    },
  };

  window.__TAURI_INTERNALS__ = {
    transformCallback(callback, once = false) {
      const id = nextCallbackId;
      nextCallbackId += 1;
      callbacks.set(id, { callback, once });
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    runCallback(id, payload) {
      const entry = callbacks.get(id);
      if (!entry) return;
      entry.callback(payload);
      if (entry.once) callbacks.delete(id);
    },
    async invoke(command, args = {}) {
      const handler = commands[command];
      if (!handler) throw new Error(`Renderer QA did not mock native command: ${command}`);
      return handler(args);
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener() {},
  };

  window.__CODELIT_PARALLEL_QA__ = {
    snapshot() {
      return {
        activeBotId,
        bots: clone(bots),
        providerRuns: [...providerRuns.entries()].map(([runId, run]) => ({
          runId,
          settled: run.settled,
          attempt: run.attempt,
          prompt: run.request.prompt,
          owner: clone(runOwners.get(runId)),
        })),
        cancelCalls: [...cancelCalls],
        approvalDecisions: clone(approvalDecisions),
        profileUpdates: clone(profileUpdates),
        schedules: clone(schedules),
        eventRoutines: clone(eventRoutines),
        memories: clone(memories),
        memoryProposals: clone(memoryProposals),
        skills: clone(skills),
        botTables: clone(botTables),
        botTableRows: clone(Object.fromEntries(botTableRows)),
        exportedBotTables: clone(exportedBotTables),
        quarantinedBrowserDownloads: clone(quarantinedBrowserDownloads),
        releasedBrowserDownloads: clone(releasedBrowserDownloads),
        delegations: clone(delegations),
        groupMembers: clone(Object.fromEntries(groupMembers)),
        computerScopes: clone(computerScopes),
        computerActions: clone(computerActions),
        computerTakeOvers: clone(computerTakeOvers),
        browserSessions: clone([...browserSessions.values()]),
        browserTeachings: clone([...browserTeachings.values()]),
        browserApprovals: clone(browserApprovals),
        browserActions: clone(browserActions),
        mcpApprovals: clone(mcpApprovals),
        mcpActions: clone(mcpActions),
        unexpectedActionReports: clone(unexpectedActionReports),
        exportedPilotReports: clone(exportedPilotReports),
        preparedBrowserRunIds: clone([...preparedBrowserApprovals.keys()]),
        preparedMcpRunIds: clone([...preparedMcpApprovals.keys()]),
        approvals: clone([...workspaces.values()].flatMap((workspace) => workspace.approvals)),
        checkpoints: clone([...workspaces.values()].flatMap((workspace) => workspace.runCheckpoints)),
        receipts: clone(bots.flatMap((bot) => findWorkspace(bot.threadId).receipts)),
      };
    },
    usedBrowserValue(value) {
      return browserActionRuntimeValues.includes(value);
    },
    emit(runId, eventType, message, payload) {
      return emitProviderEvent(runId, eventType, message, payload);
    },
    complete(runId, summary) {
      return settleProviderRun(runId, "completed", summary);
    },
    completeWithItems(runId, summary, items) {
      return settleProviderRun(runId, "completed", summary, items);
    },
    fail(runId, summary) {
      return settleProviderRun(runId, "failed", summary);
    },
    seedApproval(botId) {
      const bot = findBot(botId);
      const workspace = findWorkspace(bot.threadId);
      const runId = `run-approval-${botId}`;
      const approvalId = `approval-${runId}`;
      const createdAt = timestamp();
      runOwners.set(runId, { botId, threadId: bot.threadId });
      workspace.thread.status = "needs-input";
      workspace.thread.activeRunRef = runId;
      workspace.thread.updatedAt = createdAt;
      workspace.approvals = [{
        id: approvalId,
        runId,
        stepIndex: 0,
        status: "awaiting",
        body: {
          kind: "browser-read",
          request: "Inspect https://codelit.io and summarize the homepage.",
          target: { url: "https://codelit.io/", host: "codelit.io" },
          botId,
          botVersion: bot.currentVersion,
          engine: { provider: "codex", model: "default" },
          selectionMode: bot.spec.enginePolicy.mode,
          meteredFallbackAuthorized: bot.spec.enginePolicy.mode === "auto"
            && bot.spec.enginePolicy.allowMeteredFallback,
          approvalMode: "ask",
          decisionSource: "pending-user",
          safetyClass: "read-only-browser",
        },
        createdAt,
        updatedAt: createdAt,
      }];
      replaceBot(botId, (current) => ({
        ...current,
        status: "waiting",
        latestStatus: "Waiting to read codelit.io",
        updatedAt: createdAt,
      }));
      return { approvalId, runId };
    },
  };
}

async function auditCurrentSurface(page, matrix, surface, consoleIssues) {
  const accessibility = await page.evaluate(async () => {
    const result = await globalThis.axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
    });
    return result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.join(" ")),
    }));
  });
  const layout = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const content = document.querySelector(".bots-thread-scroll");
    const composer = document.querySelector(".bots-composer");
    const topbar = document.querySelector(".bots-topbar");
    const skeletons = [...document.querySelectorAll(".bots-loading")]
      .filter((element) => getComputedStyle(element).visibility !== "hidden").length;
    const unexpectedScrollers = [...document.querySelectorAll("body *")].flatMap((element) => {
      const style = getComputedStyle(element);
      const scrollable = /(auto|scroll)/.test(style.overflowY)
        && element.scrollHeight > element.clientHeight + 2;
      if (!scrollable || element.matches(
        ".bots-thread-scroll, .bots-roster, .bots-settings, .bots-settings-content, .bots-new-sheet, .bots-profile-editor, textarea, select",
      )) return [];
      return [element.className || element.tagName.toLowerCase()];
    });
    const composerBounds = composer?.getBoundingClientRect();
    const topbarBounds = topbar?.getBoundingClientRect();
    return {
      outerHorizontalOverflow: Math.max(root.scrollWidth - root.clientWidth, body.scrollWidth - body.clientWidth),
      outerVerticalOverflow: Math.max(root.scrollHeight - root.clientHeight, body.scrollHeight - body.clientHeight),
      contentScrollable: Boolean(content && content.scrollHeight >= content.clientHeight),
      composerInViewport: Boolean(composerBounds
        && composerBounds.left >= 0
        && composerBounds.right <= window.innerWidth
        && composerBounds.bottom <= window.innerHeight
        && composerBounds.top >= 0),
      topbarInViewport: Boolean(topbarBounds
        && topbarBounds.top === 0
        && topbarBounds.left >= 0
        && topbarBounds.right <= window.innerWidth),
      unexpectedScrollers,
      skeletons,
      domNodes: document.getElementsByTagName("*").length,
    };
  });
  const issues = [];
  if (accessibility.length) issues.push(`accessibility: ${JSON.stringify(accessibility)}`);
  if (consoleIssues.length) issues.push(`console: ${consoleIssues.join(" | ")}`);
  if (layout.outerHorizontalOverflow > 1) issues.push(`outer horizontal overflow: ${layout.outerHorizontalOverflow}px`);
  if (layout.outerVerticalOverflow > 1) issues.push(`outer vertical overflow: ${layout.outerVerticalOverflow}px`);
  if (!layout.contentScrollable) issues.push("the bot conversation does not own the main scroll region");
  if (!layout.composerInViewport) issues.push("the composer is not fully visible in the viewport");
  if (!layout.topbarInViewport) issues.push("the bot top bar is not fixed inside the viewport");
  if (layout.unexpectedScrollers.length) issues.push(`unexpected nested scrollers: ${layout.unexpectedScrollers.join(", ")}`);
  if (layout.skeletons) issues.push("a loading skeleton remained visible");
  if (layout.domNodes > 2_500) issues.push(`DOM budget exceeded: ${layout.domNodes} nodes`);
  return { matrix: matrix.id, surface, accessibility, layout, issues };
}

async function exerciseSurface(page, label) {
  if (label !== "Bots") return;
  const composer = page.getByLabel("Message Codelit");
  await composer.fill("Draft a private project review");
  if (await composer.inputValue() !== "Draft a private project review") {
    throw new Error("The bot composer did not retain input.");
  }
  await composer.fill("");

  const stoppedRunsBeforeGreeting = await page.getByText("Run stopped", { exact: true }).count();
  await composer.fill("hi");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.locator(".bot-message.assistant")
    .filter({ hasText: "Hi! I'm Codelit. What should we work on?" })
    .last()
    .waitFor({ state: "visible", timeout: 3_000 });
  const stoppedRunsAfterGreeting = await page.getByText("Run stopped", { exact: true }).count();
  if (stoppedRunsAfterGreeting !== stoppedRunsBeforeGreeting) {
    throw new Error("A plain greeting created a stopped run instead of a local conversation reply.");
  }

  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await page.getByRole("button", { name: "Open sidebar" }).waitFor({ state: "visible" });
  if (await page.locator('aside[aria-label="Bots"]').getAttribute("aria-hidden") !== "true") {
    throw new Error("The collapsed bot roster remained available to assistive technology.");
  }
  await page.getByRole("button", { name: "Open sidebar" }).click();
  await page.getByRole("button", { name: "New bot", exact: true }).waitFor({ state: "visible" });
}

async function auditGroundedLocalCapabilities(browser, url, records, failures, screenshots) {
  const matrix = matrices.find((candidate) => candidate.id === "release-light");
  if (!matrix) throw new Error("The release-light renderer matrix is unavailable.");
  const context = await browser.newContext({
    viewport: { width: matrix.width, height: matrix.height },
    colorScheme: matrix.colorScheme,
    locale: matrix.locale,
    reducedMotion: "reduce",
  });
  await context.addInitScript(installParallelBotTauriFixture, builtinSkillManifests);
  const page = await context.newPage();
  const consoleIssues = [];
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type())) consoleIssues.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));

  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.locator(".bots-thread").waitFor({ state: "visible", timeout: 4_000 });
    const composer = page.getByLabel("Message Alpha");
    await composer.fill("can you connect to my gmail");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForFunction(() => window.__CODELIT_PARALLEL_QA__.snapshot().providerRuns.some((run) => (
      run.owner?.botId === "bot-alpha" && run.settled === null
    )), undefined, { timeout: 5_000 });
    const snapshot = await page.evaluate(() => window.__CODELIT_PARALLEL_QA__.snapshot());
    const providerRun = snapshot.providerRuns.find((run) => (
      run.owner?.botId === "bot-alpha" && run.settled === null
    ));
    if (!providerRun?.prompt.includes("No reviewed local tool connections are ready.")) {
      throw new Error("The account request was not grounded in the reviewed local connection registry.");
    }
    await page.evaluate(({ runId }) => {
      window.__CODELIT_PARALLEL_QA__.completeWithItems(
        runId,
        "No reviewed Gmail connector is ready yet.",
        ["ACTION:blocked"],
      );
    }, { runId: providerRun.runId });
    await page.locator(".bot-message.assistant")
      .filter({ hasText: "No reviewed Gmail connector is ready yet." })
      .waitFor({ state: "visible", timeout: 5_000 });
    if (await page.getByText("There is no evidence provided", { exact: true }).count()
      || await page.getByText(/ACTION:/).count()) {
      throw new Error("A missing Gmail connector exposed internal harness language.");
    }
    await page.addScriptTag({ content: axe.source });
    const record = await auditCurrentSurface(page, matrix, "Bots", consoleIssues);
    records.push({ ...record, surface: "Grounded local capabilities" });
    failures.push(...record.issues.map((issue) => `${matrix.id}/Grounded local capabilities: ${issue}`));
    await page.screenshot({ path: resolve(outputDirectory, "grounded-local-capabilities.png") });
    screenshots.push("grounded-local-capabilities.png");
  } finally {
    await context.close();
  }
}

async function auditPanels(page, matrix, records, failures, consoleIssues, screenshots) {
  await page.getByRole("button", { name: "Safe reads: Ask first. Open approval settings", exact: true })
    .waitFor({ state: "visible" });
  const openSidebar = page.getByRole("button", { name: "Open sidebar", exact: true });
  if (await openSidebar.isVisible()) await openSidebar.click();
  consoleIssues.length = 0;
  await page.getByRole("button", { name: "New bot", exact: true }).click();
  const newBot = page.getByRole("dialog", { name: "Create a bot" });
  await newBot.waitFor({ state: "visible" });
  const starterIdea = newBot.getByRole("button", { name: "Keep a project release-ready.", exact: true });
  await starterIdea.waitFor({ state: "visible" });
  await starterIdea.click();
  if (await page.getByLabel("Bot job").inputValue() !== "Keep a project release-ready.") {
    throw new Error("The outcome-first bot idea did not populate the bot job.");
  }
  await page.getByLabel("Bot job").fill("Review release health every morning.");
  await newBot.getByText("Review Release Health Bot", { exact: true }).waitFor({ state: "visible" });
  const newBotAudit = await auditCurrentSurface(page, matrix, "New bot", consoleIssues);
  records.push(newBotAudit);
  failures.push(...newBotAudit.issues.map((issue) => `${matrix.id}/New bot: ${issue}`));
  if (matrix.width === 1440 && matrix.height === 900 && matrix.colorScheme === "light") {
    await page.screenshot({ path: resolve(outputDirectory, "new-bot.png") });
    screenshots.push("new-bot.png");
  }
  if (matrix.exercise) {
    await page.getByRole("button", { name: "Create bot", exact: true }).click();
    await newBot.waitFor({ state: "detached" });
    await page.locator(".bots-title strong").filter({ hasText: "Review Release Health Bot" }).waitFor({ state: "visible" });
    await page.locator(".bots-roster > button").filter({ hasText: "Codelit" }).click();
    await page.locator(".bots-title strong").filter({ hasText: "Codelit" }).waitFor({ state: "visible" });
  } else {
    await page.keyboard.press("Escape");
    await newBot.waitFor({ state: "detached" });
  }
  const closeSidebar = page.getByRole("button", { name: "Close sidebar", exact: true });
  if (await closeSidebar.isVisible()) await closeSidebar.click();

  consoleIssues.length = 0;
  await page.getByRole("button", { name: "Open settings" }).click();
  const settingsPanel = page.getByRole("dialog", { name: "Settings" });
  await settingsPanel.waitFor({ state: "visible" });
  await settingsPanel.getByRole("heading", { name: "General", exact: true }).waitFor({ state: "visible" });
  await settingsPanel.getByRole("heading", { name: "Engine", exact: true }).waitFor({ state: "visible" });
  await settingsPanel.getByRole("heading", { name: "Autonomy", exact: true }).waitFor({ state: "visible" });
  const pauseAllRoutines = settingsPanel.getByRole("switch", { name: /Pause all routines/ });
  const quietHours = settingsPanel.getByRole("switch", { name: /Quiet hours/ });
  const dailyDigest = settingsPanel.getByRole("switch", { name: /Daily digest/ });
  if (await pauseAllRoutines.count() === 0) {
    throw new Error(`Autonomy controls were unavailable in General settings: ${await settingsPanel.innerText()}`);
  }
  await pauseAllRoutines.scrollIntoViewIfNeeded();
  await pauseAllRoutines.waitFor({ state: "visible" });
  await quietHours.scrollIntoViewIfNeeded();
  await quietHours.waitFor({ state: "visible" });
  await dailyDigest.scrollIntoViewIfNeeded();
  await dailyDigest.waitFor({ state: "visible" });
  if (matrix.exercise) {
    await quietHours.click();
    await settingsPanel.getByLabel("From", { exact: true }).waitFor({ state: "visible" });
    await settingsPanel.getByLabel("Until", { exact: true }).waitFor({ state: "visible" });
    await dailyDigest.click();
    await settingsPanel.getByLabel("At", { exact: true }).waitFor({ state: "visible" });
  }

  await settingsPanel.getByRole("button", { name: "Intelligence", exact: true }).click();
  await settingsPanel.getByRole("heading", { name: "Models & providers", exact: true }).waitFor({ state: "visible" });
  await settingsPanel.getByRole("heading", { name: "On this Mac", exact: true }).waitFor({ state: "visible" });
  if (matrix.width === 1440 && matrix.height === 900 && matrix.colorScheme === "light") {
    await page.screenshot({ path: resolve(outputDirectory, "settings-intelligence.png") });
    screenshots.push("settings-intelligence.png");
  }
  if (matrix.id === "minimum-dark") {
    await page.screenshot({ path: resolve(outputDirectory, "settings-intelligence-compact-dark.png") });
    screenshots.push("settings-intelligence-compact-dark.png");
  }
  await settingsPanel.getByRole("tab", { name: "Subscriptions", exact: true }).click();
  await settingsPanel.getByRole("heading", { name: "Subscriptions", exact: true }).waitFor({ state: "visible" });
  await settingsPanel.getByRole("tab", { name: "API keys", exact: true }).click();
  await settingsPanel.getByRole("heading", { name: "API keys", exact: true }).waitFor({ state: "visible" });
  const apiKeyInputs = settingsPanel.locator('.provider-center-key-form input[type="password"]');
  if (await apiKeyInputs.count() !== 3) {
    throw new Error("Provider Center did not render three masked API-key inputs.");
  }
  if (await settingsPanel.getByText("this engine never enters Auto silently", { exact: false }).count() !== 3) {
    throw new Error("Provider Center did not show the metered Auto boundary for every API-key provider.");
  }

  await settingsPanel.getByRole("button", { name: "Privacy", exact: true }).click();
  await settingsPanel.getByRole("heading", { name: "Privacy", exact: true }).waitFor({ state: "visible" });
  await settingsPanel.getByRole("button", { name: /Export all local data/ }).waitFor({ state: "visible" });
  await settingsPanel.getByRole("button", { name: /Private product report/ }).waitFor({ state: "visible" });
  const deleteWorkspace = settingsPanel.getByRole("button", { name: /Delete local workspace/ });
  await deleteWorkspace.waitFor({ state: "visible" });
  const autoApprove = settingsPanel.getByRole("switch", { name: /Auto approve safe reads/ });
  await autoApprove.waitFor({ state: "visible" });
  if (await autoApprove.getAttribute("aria-checked") !== "false") {
    throw new Error("A new bot did not start in ask-first approval mode.");
  }
  if (matrix.exercise) {
    await autoApprove.click();
    await page.waitForFunction(() => (
      document.querySelector('[role="switch"][aria-checked="true"]') !== null
    ));
    await deleteWorkspace.click();
    const deleteConfirmation = settingsPanel.getByLabel("Type DELETE to continue", { exact: true });
    await deleteConfirmation.fill("DELETE");
    await page.screenshot({ path: resolve(outputDirectory, "settings-delete-confirmation.png") });
    screenshots.push("settings-delete-confirmation.png");
    if (!await settingsPanel.getByRole("button", { name: "Delete local data", exact: true }).isDisabled()) {
      throw new Error("Browser preview enabled a native-only local deletion command.");
    }
    await settingsPanel.getByRole("button", { name: "Cancel", exact: true }).click();
    await deleteConfirmation.waitFor({ state: "detached" });
  }
  await settingsPanel.getByRole("button", { name: "General", exact: true }).click();
  await settingsPanel.getByRole("heading", { name: "General", exact: true }).waitFor({ state: "visible" });
  const settings = await auditCurrentSurface(page, matrix, "Settings", consoleIssues);
  records.push(settings);
  failures.push(...settings.issues.map((issue) => `${matrix.id}/Settings: ${issue}`));
  if (matrix.width === 1440 && matrix.height === 900 && matrix.colorScheme === "light") {
    await page.screenshot({ path: resolve(outputDirectory, "settings.png") });
    screenshots.push("settings.png");
  }
  if (matrix.width === 1440 && matrix.height === 900 && matrix.colorScheme === "dark") {
    await page.screenshot({ path: resolve(outputDirectory, "settings-dark.png") });
    screenshots.push("settings-dark.png");
  }
  if (matrix.id === "minimum-light") {
    await page.screenshot({ path: resolve(outputDirectory, "settings-compact.png") });
    screenshots.push("settings-compact.png");
  }
  if (matrix.id === "minimum-dark") {
    await page.screenshot({ path: resolve(outputDirectory, "settings-compact-dark.png") });
    screenshots.push("settings-compact-dark.png");
  }
  await settingsPanel.getByRole("button", { name: "Close settings", exact: true }).click();
  await settingsPanel.waitFor({ state: "detached" });
  if (matrix.exercise) {
    await page.getByRole("button", { name: "Safe reads: Auto. Open approval settings", exact: true })
      .waitFor({ state: "visible" });
  }
}

async function auditPrivateProductReport(browser, url, matrix, records, failures, screenshots) {
  const context = await browser.newContext({
    viewport: { width: matrix.width, height: matrix.height },
    colorScheme: matrix.colorScheme,
    locale: matrix.locale,
    reducedMotion: "reduce",
  });
  await context.addInitScript(installParallelBotTauriFixture, builtinSkillManifests);
  const page = await context.newPage();
  const consoleIssues = [];
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type())) consoleIssues.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));
  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.getByLabel("Message Alpha").waitFor({ state: "visible", timeout: 4_000 });
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("button", { name: "Privacy", exact: true }).click();
    await settings.getByRole("button", { name: /Private product report/ }).click();
    await settings.getByLabel("Private product report summary").waitFor({ state: "visible" });
    await settings.getByText("This stays on your Mac until you export it.", { exact: false }).waitFor({ state: "visible" });
    await settings.getByText("Report an unexpected action", { exact: true }).click();
    await settings.getByLabel("Unexpected action category").selectOption("unapproved-write");
    await settings.getByRole("button", { name: "Record locally", exact: true }).click();
    await settings.getByText("1 unexpected action recorded.", { exact: true }).waitFor({ state: "visible" });
    await settings.getByRole("button", { name: "Export JSON", exact: true }).click();
    await page.getByText("Exported Codelit Private Product Report.json", { exact: true }).waitFor({ state: "visible" });
    const snapshot = await page.evaluate(() => window.__CODELIT_PARALLEL_QA__.snapshot());
    if (snapshot.unexpectedActionReports.join(",") !== "unapproved-write") {
      throw new Error("Private report QA did not preserve the bounded safety category.");
    }
    if (snapshot.exportedPilotReports.length !== 1) {
      throw new Error("Private report QA did not perform the explicit JSON export.");
    }
    await page.addScriptTag({ content: axe.source });
    consoleIssues.length = 0;
    const record = await auditCurrentSurface(page, matrix, "Private product report", consoleIssues);
    records.push(record);
    failures.push(...record.issues.map((issue) => `${matrix.id}/Private product report: ${issue}`));
    const screenshot = matrix.id === "minimum-dark"
      ? "settings-private-report-compact-dark.png"
      : "settings-private-report.png";
    await page.screenshot({ path: resolve(outputDirectory, screenshot) });
    screenshots.push(screenshot);
  } finally {
    await context.close();
  }
}

async function auditBrowserApproval(page, matrix, records, failures, consoleIssues, screenshots) {
  const now = new Date().toISOString();
  await page.evaluate((createdAt) => {
    const key = "codelit.mac.bots.v1";
    const raw = localStorage.getItem(key);
    if (!raw) throw new Error("The browser QA bot catalog was not initialized.");
    const catalog = JSON.parse(raw);
    const runId = "run-browser-approval-qa";
    catalog.activeBot.spec = {
      ...catalog.activeBot.spec,
      permissionPolicy: {
        ...catalog.activeBot.spec.permissionPolicy,
        approvalMode: "ask",
      },
    };
    catalog.activeBot.status = "waiting";
    catalog.activeBot.latestStatus = "Waiting to read codelit.io";
    catalog.activeBot.updatedAt = createdAt;
    catalog.bots = catalog.bots.map((bot) => bot.id === catalog.activeBot.id
      ? catalog.activeBot
      : bot);
    catalog.workspace.thread = {
      ...catalog.workspace.thread,
      status: "needs-input",
      activeRunRef: runId,
      updatedAt: createdAt,
    };
    catalog.workspace.approvals = [{
      id: `approval-${runId}`,
      runId,
      stepIndex: 0,
      status: "awaiting",
      body: {
        kind: "browser-read",
        request: "Inspect https://codelit.io and summarize the homepage.",
        target: { url: "https://codelit.io/", host: "codelit.io" },
        botId: catalog.activeBot.id,
        botVersion: catalog.activeBot.currentVersion,
        engine: { provider: "codex", model: "default" },
        selectionMode: "auto",
        meteredFallbackAuthorized: false,
        approvalMode: "ask",
      },
      createdAt,
      updatedAt: createdAt,
    }];
    localStorage.setItem(key, JSON.stringify(catalog));
  }, now);
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".bots-thread").waitFor({ state: "visible", timeout: 4_000 });
  await page.addScriptTag({ content: axe.source });
  const approval = page.getByRole("region", { name: "Read codelit.io?" });
  await approval.waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Safe reads: Ask first. Open approval settings", exact: true })
    .waitFor({ state: "visible" });
  await approval.getByRole("button", { name: "Always allow codelit.io", exact: true })
    .waitFor({ state: "visible" });
  consoleIssues.length = 0;
  const approvalAudit = await auditCurrentSurface(page, matrix, "Website approval", consoleIssues);
  records.push(approvalAudit);
  failures.push(...approvalAudit.issues.map((issue) => `${matrix.id}/Website approval: ${issue}`));
  if (matrix.width === 1440 && matrix.height === 900 && matrix.colorScheme === "light") {
    await page.screenshot({ path: resolve(outputDirectory, "website-approval.png") });
    screenshots.push("website-approval.png");
  }
  if (matrix.id === "minimum-light") {
    await page.screenshot({ path: resolve(outputDirectory, "website-approval-compact.png") });
    screenshots.push("website-approval-compact.png");
  }
  if (matrix.exercise) {
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    const settingsPanel = page.getByRole("dialog", { name: "Settings" });
    await settingsPanel.waitFor({ state: "visible" });
    await settingsPanel.getByRole("button", { name: "Privacy", exact: true }).click();
    const autoApprove = settingsPanel.getByRole("switch", { name: /Auto approve safe reads/ });
    if (!await autoApprove.isDisabled()) {
      throw new Error("Broad safe-read mode remained editable while an older bot version awaited approval.");
    }
    await settingsPanel.getByRole("button", { name: "Close settings", exact: true }).click();
    await settingsPanel.waitFor({ state: "detached" });
    await approval.waitFor({ state: "visible" });
    await approval.getByRole("button", { name: "Allow once", exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Safe reads: Ask first. Open approval settings", exact: true })
      .waitFor({ state: "visible" });
    await approval.getByRole("button", { name: "Hold", exact: true }).click();
    await page.getByText("Run stopped", { exact: true }).waitFor({ state: "visible", timeout: 3_000 });
    await approval.waitFor({ state: "detached" });
  }
}

async function auditRunReceipt(page, matrix, records, failures, consoleIssues, screenshots) {
  const now = new Date().toISOString();
  await page.evaluate((createdAt) => {
    const key = "codelit.mac.bots.v1";
    const raw = localStorage.getItem(key);
    if (!raw) throw new Error("The receipt QA bot catalog was not initialized.");
    const catalog = JSON.parse(raw);
    const runId = "run-browser-receipt-qa";
    const nextSequence = catalog.workspace.thread.latestBlockSequence + 1;
    catalog.activeBot.status = "done";
    catalog.activeBot.latestStatus = "Finished with Built-in MLX";
    catalog.activeBot.updatedAt = createdAt;
    catalog.bots = catalog.bots.map((bot) => bot.id === catalog.activeBot.id ? catalog.activeBot : bot);
    catalog.workspace.thread = {
      ...catalog.workspace.thread,
      status: "completed",
      latestBlockSequence: nextSequence + 1,
      activeRunRef: runId,
      updatedAt: createdAt,
    };
    catalog.workspace.approvals = [];
    catalog.workspace.blocks = catalog.workspace.blocks.filter((block) => block.type === "assistant-message").slice(0, 1);
    catalog.workspace.blocks.push(
      {
        id: "block-clean-user",
        sequence: nextSequence - 2,
        createdAt,
        type: "user-message",
        text: "How can you help me prepare a product release?",
      },
      {
        id: "block-clean-answer",
        sequence: nextSequence - 1,
        createdAt,
        type: "assistant-message",
        text: "I can turn the release into a clear checklist, review risks, draft notes, and keep the next action visible. Start by telling me what you are shipping and when it needs to be ready.",
      },
      {
        id: `block-${runId}`,
        sequence: nextSequence,
        createdAt,
        type: "run",
        runId,
        label: "mlx local run",
        detail: "Codelit returned a useful local answer.",
        status: "completed",
      },
      {
        id: `block-receipt-${runId}`,
        sequence: nextSequence + 1,
        createdAt,
        type: "receipt",
        artifact: {
          kind: "receipt",
          id: "artifact-receipt-local",
          version: runId,
          projectId: "local-project",
          title: "Local run receipt",
          editorHref: "/local/receipt/artifact-receipt-local",
          createdAt,
        },
        summary: "mlx produced a local receipt with no metered fallback.",
      },
    );
    catalog.workspace.receipts.push({
      id: `receipt-${runId}`,
      runId,
      artifactId: "artifact-plan-ship-local",
      body: {
        status: "completed",
        provider: "mlx",
        model: "mlx-community/Qwen3-0.6B-4bit",
        selectionMode: "auto",
        eventCount: 7,
        meteredFallbackAuthorized: false,
        meteredProviderInvocationStarted: false,
        billingFallback: false,
        details: {
          approval: {
            mode: "safe-auto",
            decisionSource: "bot-safe-mode",
            scope: "read-only-browser",
          },
          browser: {
            host: "codelit.io",
            mode: "read",
            proofs: [{ evidence: [{ id: "dom-visible-text", type: "dom" }] }],
          },
        },
      },
      createdAt,
    });
    localStorage.setItem(key, JSON.stringify(catalog));
  }, now);
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".bots-thread").waitFor({ state: "visible", timeout: 4_000 });
  if (await page.locator(".bot-receipt, .bot-receipt-legacy").count()) {
    throw new Error("Internal run receipts leaked into the bot conversation.");
  }
  const snapshot = await page.evaluate(() => JSON.parse(localStorage.getItem("codelit.mac.bots.v1") || "null"));
  const persisted = snapshot?.workspace?.receipts?.find((receipt) => receipt.runId === "run-browser-receipt-qa");
  if (persisted?.body?.details?.approval?.decisionSource !== "bot-safe-mode") {
    throw new Error("The private run receipt was not retained after its conversation card was hidden.");
  }
  await page.addScriptTag({ content: axe.source });
  consoleIssues.length = 0;
  const receiptAudit = await auditCurrentSurface(page, matrix, "Conversation without receipt noise", consoleIssues);
  records.push(receiptAudit);
  failures.push(...receiptAudit.issues.map((issue) => `${matrix.id}/Conversation without receipt noise: ${issue}`));
  if (matrix.width === 1440 && matrix.height === 900 && matrix.colorScheme === "light") {
    await page.screenshot({ path: resolve(outputDirectory, "clean-conversation.png") });
    screenshots.push("clean-conversation.png");
  }
  if (matrix.width === 1440 && matrix.height === 900 && matrix.colorScheme === "dark") {
    await page.screenshot({ path: resolve(outputDirectory, "clean-conversation-dark.png") });
    screenshots.push("clean-conversation-dark.png");
  }
  if (matrix.id === "minimum-light") {
    await page.screenshot({ path: resolve(outputDirectory, "clean-conversation-compact.png") });
    screenshots.push("clean-conversation-compact.png");
  }
}

async function auditPersistentBrowserDomains(browser, url, records, failures, screenshots) {
  const matrix = matrices.find((candidate) => candidate.id === "release-light");
  if (!matrix) throw new Error("The release-light renderer matrix is unavailable.");
  const context = await browser.newContext({
    viewport: { width: matrix.width, height: matrix.height },
    colorScheme: matrix.colorScheme,
    locale: matrix.locale,
    reducedMotion: "reduce",
  });
  await context.addInitScript(installParallelBotTauriFixture, builtinSkillManifests);
  const page = await context.newPage();
  const consoleIssues = [];
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type())) consoleIssues.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));
  const snapshot = () => page.evaluate(() => window.__CODELIT_PARALLEL_QA__.snapshot());
  const waitForProviderRun = async (botId, previousRunId = null) => {
    await page.waitForFunction(({ id, previous }) => {
      const current = window.__CODELIT_PARALLEL_QA__.snapshot();
      return current.providerRuns.some((run) => (
        run.owner?.botId === id && run.settled === null && run.runId !== previous
      ));
    }, { id: botId, previous: previousRunId }, { timeout: 5_000 });
    const current = await snapshot();
    const run = current.providerRuns.find((candidate) => (
      candidate.owner?.botId === botId
      && candidate.settled === null
      && candidate.runId !== previousRunId
    ));
    if (!run) throw new Error(`A browser provider run was not created for ${botId}.`);
    return run.runId;
  };

  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.locator(".bots-thread").waitFor({ state: "visible", timeout: 4_000 });
    const alphaComposer = page.getByLabel("Message Alpha");
    await alphaComposer.fill("Inspect https://codelit.io/pricing and summarize the visible plans.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const approval = page.getByRole("region", { name: "Read codelit.io?" });
    await approval.waitFor({ state: "visible", timeout: 5_000 });
    await approval.getByRole("button", { name: "Always allow codelit.io", exact: true }).click();
    const firstRun = await waitForProviderRun("bot-alpha");
    await page.evaluate(({ runId }) => {
      window.__CODELIT_PARALLEL_QA__.complete(runId, "The pricing page is visible and ready for review.");
    }, { runId: firstRun });
    await page.locator(".bot-message.assistant")
      .filter({ hasText: "The pricing page is visible and ready for review." })
      .waitFor({ state: "visible", timeout: 5_000 });
    await page.getByRole("button", {
      name: "Website access: 1 saved domain. Open approval settings",
      exact: true,
    }).waitFor({ state: "visible" });
    const afterGrant = await snapshot();
    const alpha = afterGrant.bots.find((bot) => bot.id === "bot-alpha");
    if (JSON.stringify(alpha?.spec.permissionPolicy.browserDomains) !== JSON.stringify(["codelit.io"])) {
      throw new Error("The exact browser domain was not retained on Alpha's versioned bot policy.");
    }

    await alphaComposer.fill("Inspect https://codelit.io/showcase and summarize what changed.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const secondRun = await waitForProviderRun("bot-alpha", firstRun);
    if (await approval.count()) {
      throw new Error("Alpha asked again for a low-risk read on its saved domain.");
    }
    await page.evaluate(({ runId }) => {
      window.__CODELIT_PARALLEL_QA__.complete(runId, "The showcase remains available to this bot.");
    }, { runId: secondRun });
    await page.locator(".bot-message.assistant")
      .filter({ hasText: "The showcase remains available to this bot." })
      .waitFor({ state: "visible", timeout: 5_000 });
    const afterReuse = await snapshot();
    const receipt = afterReuse.receipts.find((candidate) => candidate.runId === secondRun);
    if (receipt?.body?.details?.approval?.decisionSource !== "bot-domain-scope") {
      throw new Error(`The saved-domain run lost its receipt provenance: ${JSON.stringify(receipt)}`);
    }
    if (await page.locator(".bot-receipt, .bot-receipt-legacy").count()) {
      throw new Error("Saved-domain receipt details leaked into the conversation.");
    }

    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("button", { name: "Privacy", exact: true }).click();
    await settings.getByLabel("Saved website domains for Alpha").waitFor({ state: "visible" });
    await settings.getByRole("button", { name: "Remove codelit.io from Alpha", exact: true })
      .waitFor({ state: "visible" });
    await settings.getByRole("button", { name: "Close settings", exact: true }).click();

    await page.getByRole("button", { name: "New bot", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create a bot" });
    await dialog.getByLabel("Bot job").fill("Inspect a second bot's approved websites.");
    await dialog.getByRole("button", { name: "Create bot", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    const secondBotSnapshot = await snapshot();
    const secondBot = secondBotSnapshot.bots.find((candidate) => candidate.id === secondBotSnapshot.activeBotId);
    if (!secondBot || secondBot.id === "bot-alpha") throw new Error("The isolated browser-domain bot was not created.");
    const firstMove = await waitForProviderRun(secondBot.id);
    await page.evaluate(({ runId }) => {
      window.__CODELIT_PARALLEL_QA__.complete(runId, "The second bot is ready for its first website task.");
    }, { runId: firstMove });
    await page.locator(".bot-message.assistant")
      .filter({ hasText: "The second bot is ready for its first website task." })
      .waitFor({ state: "visible", timeout: 5_000 });
    await page.getByLabel(`Message ${secondBot.name}`).waitFor({ state: "visible" });
    await page.waitForFunction((name) => {
      const composer = [...document.querySelectorAll("textarea")]
        .find((candidate) => candidate.getAttribute("aria-label") === `Message ${name}`);
      return composer instanceof HTMLTextAreaElement && !composer.disabled;
    }, secondBot.name, { timeout: 5_000 });
    await page.getByLabel(`Message ${secondBot.name}`)
      .fill("Inspect https://codelit.io/pricing and summarize the visible plans.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const isolatedApproval = page.getByRole("region", { name: "Read codelit.io?" });
    await isolatedApproval.waitFor({ state: "visible", timeout: 5_000 });
    const isolated = await snapshot();
    const isolatedBot = isolated.bots.find((candidate) => candidate.id === secondBot.id);
    if (isolatedBot?.spec.permissionPolicy.browserDomains.length !== 0) {
      throw new Error("Alpha's browser domain leaked into another bot.");
    }

    await page.addScriptTag({ content: axe.source });
    consoleIssues.length = 0;
    const audit = await auditCurrentSurface(page, matrix, "Per-bot browser domains", consoleIssues);
    records.push(audit);
    failures.push(...audit.issues.map((issue) => `${matrix.id}/Per-bot browser domains: ${issue}`));
    await page.screenshot({ path: resolve(outputDirectory, "browser-domain-isolation.png") });
    screenshots.push("browser-domain-isolation.png");
    await isolatedApproval.getByRole("button", { name: "Hold", exact: true }).click();
  } finally {
    await context.close();
  }
}

async function auditTypedBrowserAction(browser, url, matrix, records, failures, screenshots) {
  const compact = matrix.id === "minimum-light";
  const context = await browser.newContext({
    viewport: { width: matrix.width, height: matrix.height },
    colorScheme: matrix.colorScheme,
    locale: matrix.locale,
    reducedMotion: "reduce",
  });
  await context.addInitScript(installParallelBotTauriFixture, builtinSkillManifests);
  const page = await context.newPage();
  const consoleIssues = [];
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type())) consoleIssues.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));
  const snapshot = () => page.evaluate(() => window.__CODELIT_PARALLEL_QA__.snapshot());
  const addAudit = async (label) => {
    await page.addScriptTag({ content: axe.source });
    const record = await auditCurrentSurface(page, matrix, label, consoleIssues);
    records.push(record);
    failures.push(...record.issues.map((issue) => `${matrix.id}/${label}: ${issue}`));
  };
  const typedValue = "release candidate 7";

  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.locator(".bots-thread").waitFor({ state: "visible", timeout: 4_000 });
    await page.getByLabel("Message Alpha")
      .fill('Type "release candidate 7" into "Search" on https://codelit.io/docs');
    await page.getByRole("button", { name: "Send", exact: true }).click();

    const approval = page.getByRole("region", { name: "Run this browser action?", exact: true });
    await approval.waitFor({ state: "visible", timeout: 5_000 });
    await approval.getByText('Type 19 characters into "Search"', { exact: true }).waitFor({ state: "visible" });
    await approval.getByText("Every later action asks again.", { exact: false }).waitFor({ state: "visible" });
    const before = await snapshot();
    const prepared = before.browserApprovals.at(-1);
    const runId = prepared?.runId;
    const pendingApproval = before.approvals.find((candidate) => candidate.runId === runId);
    const pendingCheckpoint = before.checkpoints.find((candidate) => candidate.runId === runId);
    const persistedBefore = JSON.stringify({
      approval: pendingApproval,
      checkpoint: pendingCheckpoint,
      receipt: before.receipts.find((candidate) => candidate.runId === runId),
      browserApproval: prepared,
    });
    if (!runId
      || prepared.action !== "type"
      || prepared.target !== "label:Search"
      || prepared.valueLength !== 19
      || pendingApproval?.body?.kind !== "browser-action"
      || pendingApproval?.body?.browserAction?.approvalSha256 !== prepared.approvalSha256
      || pendingApproval?.body?.browserAction?.valueLength !== 19
      || Object.hasOwn(pendingApproval?.body?.browserAction || {}, "value")
      || !before.preparedBrowserRunIds.includes(runId)
      || persistedBefore.includes(typedValue)) {
      throw new Error(`The typed browser action was not redacted and bound before approval: ${persistedBefore}`);
    }

    consoleIssues.length = 0;
    await addAudit("Browser action approval");
    const approvalScreenshot = compact
      ? "browser-action-approval-compact.png"
      : "browser-action-approval.png";
    await page.screenshot({ path: resolve(outputDirectory, approvalScreenshot) });
    screenshots.push(approvalScreenshot);

    await approval.getByRole("button", { name: "Allow once", exact: true }).click();
    await page.waitForFunction((id) => window.__CODELIT_PARALLEL_QA__.snapshot().providerRuns.some((run) => (
      run.runId === id && run.settled === null
    )), runId, { timeout: 5_000 });
    await page.evaluate(({ id, summaryFails }) => {
      if (summaryFails) {
        window.__CODELIT_PARALLEL_QA__.fail(id, "The optional browser summary stopped after the action completed.");
        return;
      }
      window.__CODELIT_PARALLEL_QA__.completeWithItems(
        id,
        "The reviewed Search field changed and browser proof was saved.",
        ["Exact action completed once"],
      );
    }, { id: runId, summaryFails: compact });
    const expectedAnswer = compact
      ? "Entered 19 characters into Search on codelit.io. Browser proof was saved, but the follow-up summary did not finish."
      : "The reviewed Search field changed and browser proof was saved.";
    await page.locator(".bot-message.assistant")
      .filter({ hasText: expectedAnswer })
      .waitFor({ state: "visible", timeout: 5_000 });
    const after = await snapshot();
    const action = after.browserActions.find((candidate) => candidate.runId === runId);
    const receipt = after.receipts.find((candidate) => candidate.runId === runId);
    const checkpoint = after.checkpoints.find((candidate) => candidate.runId === runId);
    const persistedAfter = JSON.stringify({
      approval: after.approvals.find((candidate) => candidate.runId === runId),
      checkpoint,
      receipt,
      browserApproval: after.browserApprovals.find((candidate) => candidate.runId === runId),
      browserAction: action,
    });
    if (!await page.evaluate((value) => window.__CODELIT_PARALLEL_QA__.usedBrowserValue(value), typedValue)
      || after.browserActions.filter((candidate) => candidate.runId === runId).length !== 1
      || action?.action !== "type"
      || action?.target !== "label:Search"
      || action?.valueLength !== 19
      || after.preparedBrowserRunIds.includes(runId)
      || receipt?.body?.status !== "completed"
      || receipt?.body?.details?.approval?.scope !== "typed-browser-action"
      || receipt?.body?.details?.approval?.approvalSha256 !== prepared.approvalSha256
      || receipt?.body?.details?.browser?.mode !== "write"
      || receipt?.body?.details?.browser?.target !== "Search"
      || receipt?.body?.details?.browser?.valueLength !== 19
      || receipt?.body?.details?.browser?.proofs?.length !== 1
      || receipt?.body?.details?.summary?.status !== (compact ? "failed" : "completed")
      || checkpoint?.body?.priorSteps?.[0]?.proofIds?.length !== 1
      || persistedAfter.includes(typedValue)) {
      throw new Error(`The typed browser action lost its exact, private receipt boundary: ${persistedAfter}`);
    }

    const replayError = await page.evaluate(async ({ id, approvalSha256 }) => {
      try {
        await window.__TAURI_INTERNALS__.invoke("run_local_tool_batch", {
          request: {
            runId: id,
            tools: ["Browser act"],
            handoff: "Type 19 characters into Search on codelit.io",
            approvalSha256,
            toolInputs: {},
            browserSessionId: `browser-${id}`,
            browserProjectId: "bot-alpha",
          },
        });
        return null;
      } catch (reason) {
        return reason instanceof Error ? reason.message : String(reason);
      }
    }, { id: runId, approvalSha256: prepared.approvalSha256 });
    if (!replayError?.includes("did not match its exact approval")) {
      throw new Error(`The consumed browser approval replayed a completed action: ${String(replayError)}`);
    }
    if ((await snapshot()).browserActions.filter((candidate) => candidate.runId === runId).length !== 1) {
      throw new Error("The consumed browser approval replayed a completed action.");
    }

    consoleIssues.length = 0;
    await addAudit("Browser action completion");
    const completedScreenshot = compact
      ? "browser-action-complete-compact.png"
      : "browser-action-complete.png";
    await page.screenshot({ path: resolve(outputDirectory, completedScreenshot) });
    screenshots.push(completedScreenshot);
  } finally {
    await context.close();
  }
}

async function auditQuarantinedBrowserDownload(browser, url, matrix, records, failures, screenshots) {
  const compact = matrix.id === "minimum-light";
  const context = await browser.newContext({
    viewport: { width: matrix.width, height: matrix.height },
    colorScheme: matrix.colorScheme,
    locale: matrix.locale,
    reducedMotion: "reduce",
  });
  await context.addInitScript(installParallelBotTauriFixture, builtinSkillManifests);
  const page = await context.newPage();
  const consoleIssues = [];
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type())) consoleIssues.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));
  const snapshot = () => page.evaluate(() => window.__CODELIT_PARALLEL_QA__.snapshot());
  const addAudit = async (label) => {
    await page.addScriptTag({ content: axe.source });
    const record = await auditCurrentSurface(page, matrix, label, consoleIssues);
    records.push(record);
    failures.push(...record.issues.map((issue) => `${matrix.id}/${label}: ${issue}`));
  };

  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.locator(".bots-thread").waitFor({ state: "visible", timeout: 4_000 });
    await page.getByLabel("Message Alpha")
      .fill('Download "Release report" from https://codelit.io/releases');
    await page.getByRole("button", { name: "Send", exact: true }).click();

    const approval = page.getByRole("region", { name: "Download this file?", exact: true });
    await approval.waitFor({ state: "visible", timeout: 5_000 });
    await approval.getByText('Download "Release report"', { exact: true }).waitFor({ state: "visible" });
    await approval.getByText("The bot cannot read or open", { exact: false }).waitFor({ state: "visible" });
    const before = await snapshot();
    const prepared = before.browserApprovals.at(-1);
    const runId = prepared?.runId;
    const pending = before.approvals.find((candidate) => candidate.runId === runId);
    if (!runId
      || prepared.action !== "download"
      || prepared.target !== "label:Release report"
      || prepared.valueLength !== 0
      || pending?.body?.safetyClass !== "browser-download"
      || pending?.body?.browserAction?.action !== "download"
      || !before.preparedBrowserRunIds.includes(runId)) {
      throw new Error(`The browser download was not bound to one exact approval: ${JSON.stringify({ prepared, pending })}`);
    }

    consoleIssues.length = 0;
    await addAudit("Browser download approval");
    const approvalScreenshot = compact
      ? "browser-download-approval-compact.png"
      : "browser-download-approval.png";
    await page.screenshot({ path: resolve(outputDirectory, approvalScreenshot) });
    screenshots.push(approvalScreenshot);

    await approval.getByRole("button", { name: "Allow once", exact: true }).click();
    const artifact = page.getByRole("region", { name: "Downloads waiting for you", exact: true });
    await artifact.waitFor({ state: "visible", timeout: 5_000 });
    await artifact.getByText("release-report.pdf", { exact: true }).waitFor({ state: "visible" });
    await artifact.getByText("Quarantined locally. Bots cannot read or open these files.", { exact: true })
      .waitFor({ state: "visible" });
    await page.locator(".bot-message.assistant")
      .filter({ hasText: "release-report.pdf is quarantined and waiting for you." })
      .waitFor({ state: "visible", timeout: 5_000 });
    const after = await snapshot();
    const action = after.browserActions.find((candidate) => candidate.runId === runId);
    const receipt = after.receipts.find((candidate) => candidate.runId === runId);
    const checkpoint = after.checkpoints.find((candidate) => candidate.runId === runId);
    const download = after.quarantinedBrowserDownloads.find((candidate) => candidate.sessionId === `browser-${runId}`);
    if (action?.action !== "download"
      || after.browserActions.filter((candidate) => candidate.runId === runId).length !== 1
      || after.preparedBrowserRunIds.includes(runId)
      || after.providerRuns.some((run) => run.runId === runId)
      || download?.botId !== "bot-alpha"
      || download?.fileName !== "release-report.pdf"
      || receipt?.body?.status !== "completed"
      || receipt?.body?.details?.approval?.scope !== "browser-download"
      || receipt?.body?.details?.download?.sha256 !== download?.sha256
      || checkpoint?.body?.priorSteps?.[0]?.proofIds?.length !== 2) {
      throw new Error(`The quarantined download lost its model-free receipt boundary: ${JSON.stringify({ action, download, receipt, checkpoint })}`);
    }

    consoleIssues.length = 0;
    await addAudit("Browser download quarantine");
    const quarantineScreenshot = compact
      ? "browser-download-quarantine-compact.png"
      : "browser-download-quarantine.png";
    await page.screenshot({ path: resolve(outputDirectory, quarantineScreenshot) });
    screenshots.push(quarantineScreenshot);

    await artifact.getByRole("button", { name: "Release…", exact: true }).click();
    await artifact.waitFor({ state: "detached", timeout: 5_000 });
    const released = await snapshot();
    if (released.quarantinedBrowserDownloads.length !== 0
      || released.releasedBrowserDownloads.length !== 1
      || released.releasedBrowserDownloads[0].downloadId !== download.id) {
      throw new Error(`Explicit release did not consume the quarantined copy: ${JSON.stringify(released.releasedBrowserDownloads)}`);
    }
  } finally {
    await context.close();
  }
}

async function auditParallelBots(browser, url, records, failures, screenshots) {
  const matrix = matrices.find((candidate) => candidate.id === "release-light");
  if (!matrix) throw new Error("The release-light renderer matrix is unavailable.");
  const context = await browser.newContext({
    viewport: { width: matrix.width, height: matrix.height },
    colorScheme: matrix.colorScheme,
    locale: matrix.locale,
    reducedMotion: "reduce",
  });
  await context.addInitScript(installParallelBotTauriFixture, builtinSkillManifests);
  const page = await context.newPage();
  const consoleIssues = [];
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type())) consoleIssues.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));

  const fixtureSnapshot = () => page.evaluate(() => window.__CODELIT_PARALLEL_QA__.snapshot());
  const activeProviderRun = (botId) => page.evaluate((id) => {
    const snapshot = window.__CODELIT_PARALLEL_QA__.snapshot();
    return snapshot.providerRuns.find((run) => run.owner?.botId === id && run.settled === null)?.runId || null;
  }, botId);
  const waitForProviderRun = async (botId, previousRunId = null) => {
    await page.waitForFunction(({ id, previous }) => {
      const snapshot = window.__CODELIT_PARALLEL_QA__.snapshot();
      return snapshot.providerRuns.some((run) => (
        run.owner?.botId === id && run.settled === null && run.runId !== previous
      ));
    }, { id: botId, previous: previousRunId }, { timeout: 5_000 });
    const runId = await activeProviderRun(botId);
    if (!runId || runId === previousRunId) throw new Error(`A provider barrier was not created for ${botId}.`);
    return runId;
  };
  const botRow = (name) => page.locator(".bots-roster > button").filter({ hasText: name }).first();
  const expectEnabled = async (locator, message) => {
    await locator.waitFor({ state: "visible" });
    if (await locator.isDisabled()) throw new Error(message);
  };
  const expectLiveThinking = async (expected, excluded) => {
    const thinking = page.locator(".bot-live-thinking");
    await thinking.filter({ hasText: expected }).waitFor({ state: "visible", timeout: 5_000 });
    const text = await thinking.textContent();
    if (!text?.includes(expected)) throw new Error(`The active bot did not show its own live reasoning: ${expected}`);
    if (excluded && text.includes(excluded)) throw new Error(`The active bot leaked another bot's live reasoning: ${excluded}`);
  };

  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.locator(".bots-thread").waitFor({ state: "visible", timeout: 4_000 });
    await page.getByLabel("Message Alpha").waitFor({ state: "visible" }).catch((error) => {
      throw new Error(`Parallel bot fixture did not reach the composer: ${consoleIssues.join(" | ") || error.message}`);
    });

    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    const settingsPanel = page.getByRole("dialog", { name: "Settings" });
    await settingsPanel.getByRole("button", { name: "Intelligence", exact: true }).click();
    await settingsPanel.getByRole("tab", { name: "Subscriptions", exact: true }).click();
    const copilotSignIn = settingsPanel.getByRole("button", {
      name: "Sign in to or switch GitHub Copilot account",
      exact: true,
    });
    if (await copilotSignIn.count() !== 1) {
      throw new Error("Provider Center did not keep the installed Copilot sign-in action reachable.");
    }
    await copilotSignIn.scrollIntoViewIfNeeded();
    await copilotSignIn.waitFor({ state: "visible" });
    await settingsPanel.getByRole("button", { name: "Close settings", exact: true }).click();
    await settingsPanel.waitFor({ state: "detached" });

    await page.getByLabel("Message Alpha").fill("Prepare Alpha's release answer.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const runA = await waitForProviderRun("bot-alpha");
    await page.evaluate(({ runId }) => {
      window.__CODELIT_PARALLEL_QA__.emit(runId, "reasoning-delta", "Alpha first thought. ");
    }, { runId: runA });
    await expectLiveThinking("Alpha first thought.", "Beta");

    const newBotButton = page.getByRole("button", { name: "New bot", exact: true });
    await expectEnabled(newBotButton, "New bot was disabled while Alpha was working.");
    await expectEnabled(botRow("Alpha"), "The Alpha roster item was disabled while Alpha was working.");
    await newBotButton.click();
    const newBot = page.getByRole("dialog", { name: "Create a bot" });
    await newBot.waitFor({ state: "visible" });
    await page.getByLabel("Bot job").fill("Handle beta release questions.");
    await newBot.getByRole("button", { name: "Create bot", exact: true }).click();
    await newBot.waitFor({ state: "detached" });
    const betaName = "Handle Beta Release Bot";
    await page.locator(".bots-title strong").filter({ hasText: betaName }).waitFor({ state: "visible" });
    const afterCreate = await fixtureSnapshot();
    const botB = afterCreate.activeBotId;
    if (!botB || botB === "bot-alpha") throw new Error("The second bot was not created and selected.");
    await expectEnabled(page.getByLabel(`Message ${betaName}`), "Beta's composer was disabled while Alpha was working.");

    await page.getByLabel(`Message ${betaName}`).fill("Prepare Beta's independent release answer.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const runB = await waitForProviderRun(botB);
    await page.evaluate(({ firstRun, secondRun }) => {
      window.__CODELIT_PARALLEL_QA__.emit(firstRun, "reasoning-delta", "Alpha hidden update.");
      window.__CODELIT_PARALLEL_QA__.emit(secondRun, "reasoning-delta", "Beta only thought.");
    }, { firstRun: runA, secondRun: runB });
    await expectLiveThinking("Beta only thought.", "Alpha");

    await expectEnabled(botRow("Alpha"), "Alpha could not be selected while Beta was working.");
    await botRow("Alpha").click();
    await page.locator(".bots-title strong").filter({ hasText: "Alpha" }).waitFor({ state: "visible" });
    await expectLiveThinking("Alpha first thought. Alpha hidden update.", "Beta");
    await expectEnabled(botRow(betaName), "Beta could not be selected while both bots were working.");
    await botRow(betaName).click();
    await page.locator(".bots-title strong").filter({ hasText: betaName }).waitFor({ state: "visible" });
    await expectLiveThinking("Beta only thought.", "Alpha");

    await page.evaluate(({ runId }) => {
      window.__CODELIT_PARALLEL_QA__.complete(runId, "Beta final answer.");
    }, { runId: runB });
    await page.locator(".bot-message.assistant").filter({ hasText: "Beta final answer." })
      .waitFor({ state: "visible", timeout: 5_000 });
    const afterBeta = await fixtureSnapshot();
    if (afterBeta.receipts.filter((receipt) => receipt.runId === runB).length !== 1
      || await page.locator(".bot-receipt, .bot-receipt-legacy").count()) {
      throw new Error("Beta's private receipt was not retained cleanly outside the conversation.");
    }
    const alphaStatus = afterBeta.bots.find((candidate) => candidate.id === "bot-alpha")?.status;
    if (!["thinking", "working"].includes(alphaStatus)) {
      throw new Error(`Alpha stopped when Beta completed first: ${alphaStatus}`);
    }
    await page.screenshot({ path: resolve(outputDirectory, "parallel-bots.png") });
    screenshots.push("parallel-bots.png");

    await botRow("Alpha").click();
    await page.locator(".bots-title strong").filter({ hasText: "Alpha" }).waitFor({ state: "visible" });
    await expectLiveThinking("Alpha first thought. Alpha hidden update.", "Beta");
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    await stop.waitFor({ state: "visible" });
    await stop.click();
    await page.getByText("Run stopped", { exact: true }).waitFor({ state: "visible", timeout: 5_000 });
    const afterStop = await fixtureSnapshot();
    if (afterStop.receipts.filter((receipt) => receipt.runId === runA).length !== 1
      || await page.locator(".bot-receipt, .bot-receipt-legacy").count()) {
      throw new Error("Alpha's stopped run receipt was not retained cleanly outside the conversation.");
    }
    if (JSON.stringify(afterStop.cancelCalls) !== JSON.stringify([runA])) {
      throw new Error(`Stopping Alpha canceled the wrong runs: ${afterStop.cancelCalls.join(", ")}`);
    }
    if (afterStop.providerRuns.find((run) => run.runId === runB)?.settled !== "completed") {
      throw new Error("Stopping Alpha changed Beta's completed provider run.");
    }

    await botRow(betaName).click();
    await page.locator(".bots-title strong").filter({ hasText: betaName }).waitFor({ state: "visible" });
    await page.locator(".bot-message.assistant").filter({ hasText: "Beta final answer." }).waitFor({ state: "visible" });
    if (await page.getByText("Run stopped", { exact: true }).count()) {
      throw new Error("Alpha's stopped receipt leaked into Beta's conversation.");
    }

    const approval = await page.evaluate(() => window.__CODELIT_PARALLEL_QA__.seedApproval("bot-alpha"));
    await botRow("Alpha").click();
    const approvalRegion = page.getByRole("region", { name: "Read codelit.io?" });
    await approvalRegion.waitFor({ state: "visible", timeout: 5_000 });
    await expectEnabled(botRow(betaName), "Beta could not be selected while Alpha awaited approval.");
    await botRow(betaName).click();
    await approvalRegion.waitFor({ state: "detached" });
    await expectEnabled(
      page.getByLabel(`Message ${betaName}`),
      "Alpha's pending approval disabled Beta's composer.",
    );

    await page.getByLabel(`Message ${betaName}`).fill("Continue Beta while Alpha waits for approval.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const runB2 = await waitForProviderRun(botB, runB);
    await page.evaluate(({ runId }) => {
      window.__CODELIT_PARALLEL_QA__.emit(runId, "reasoning-delta", "Beta keeps working independently.");
    }, { runId: runB2 });
    await expectLiveThinking("Beta keeps working independently.", "Alpha");

    await botRow("Alpha").click();
    await approvalRegion.waitFor({ state: "visible" });
    const runningBeta = await fixtureSnapshot();
    if (runningBeta.providerRuns.find((run) => run.runId === runB2)?.settled !== null) {
      throw new Error("Beta did not remain active while Alpha's approval was displayed.");
    }
    await page.addScriptTag({ content: axe.source });
    consoleIssues.length = 0;
    const parallelAudit = await auditCurrentSurface(page, matrix, "Parallel bots", consoleIssues);
    records.push(parallelAudit);
    failures.push(...parallelAudit.issues.map((issue) => `${matrix.id}/Parallel bots: ${issue}`));
    await page.screenshot({ path: resolve(outputDirectory, "parallel-bot-approval.png") });
    screenshots.push("parallel-bot-approval.png");

    await approvalRegion.getByRole("button", { name: "Hold", exact: true }).click();
    await approvalRegion.waitFor({ state: "detached", timeout: 5_000 });
    const afterHold = await fixtureSnapshot();
    const held = afterHold.approvalDecisions.find((decision) => (
      decision.approvalId === approval.approvalId && decision.status === "held"
    ));
    if (!held || held.botId !== "bot-alpha" || held.runId !== approval.runId) {
      throw new Error("Alpha's approval decision was not scoped to Alpha's pending run.");
    }
    if (JSON.stringify(afterHold.cancelCalls) !== JSON.stringify([runA])) {
      throw new Error("Holding Alpha's approval canceled another provider run.");
    }

    await botRow(betaName).click();
    await expectLiveThinking("Beta keeps working independently.", "Alpha");
    await page.evaluate(({ runId }) => {
      window.__CODELIT_PARALLEL_QA__.complete(runId, "Beta follow-up answer.");
    }, { runId: runB2 });
    await page.locator(".bot-message.assistant").filter({ hasText: "Beta follow-up answer." })
      .waitFor({ state: "visible", timeout: 5_000 });
    const finished = await fixtureSnapshot();
    if (finished.providerRuns.find((run) => run.runId === runB2)?.settled !== "completed") {
      throw new Error("Beta did not finish after Alpha's approval was held.");
    }

    await botRow("Alpha").click();
    await page.locator(".bots-title strong").filter({ hasText: "Alpha" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Add conversation teammates", exact: true }).click();
    const teamDialog = page.getByRole("dialog", { name: "Conversation team" });
    await teamDialog.waitFor({ state: "visible" });
    await teamDialog.getByRole("checkbox", { name: `Add ${betaName}`, exact: true }).check();
    await teamDialog.getByText("1/2 teammates", { exact: true }).waitFor({ state: "visible" });
    await page.addScriptTag({ content: axe.source });
    consoleIssues.length = 0;
    const teamAudit = await auditCurrentSurface(page, matrix, "Conversation team", consoleIssues);
    records.push(teamAudit);
    failures.push(...teamAudit.issues.map((issue) => `${matrix.id}/Conversation team: ${issue}`));
    await page.screenshot({ path: resolve(outputDirectory, "conversation-team.png") });
    screenshots.push("conversation-team.png");
    await teamDialog.getByRole("button", { name: "Save team", exact: true }).click();
    await teamDialog.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Manage 1 conversation teammate", exact: true })
      .waitFor({ state: "visible" });
    const withTeam = await fixtureSnapshot();
    if (JSON.stringify(withTeam.groupMembers["bot-alpha"]) !== JSON.stringify([botB])) {
      throw new Error("The conversation team did not persist its selected specialist.");
    }
    await botRow(betaName).click();
    await page.getByRole("button", { name: "Add conversation teammates", exact: true })
      .waitFor({ state: "visible" });
    await botRow("Alpha").click();
    await page.getByRole("button", { name: "Manage 1 conversation teammate", exact: true })
      .waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Ask another bot", exact: true }).click();
    const betaOption = page.getByRole("option", { name: new RegExp(betaName) });
    await betaOption.waitFor({ state: "visible" });
    await betaOption.click();
    const alphaComposer = page.getByLabel("Message Alpha");
    const mentionValue = await alphaComposer.inputValue();
    if (mentionValue !== `@${betaName} `) {
      throw new Error(`The bot picker inserted an unexpected mention: ${mentionValue}`);
    }
    const delegatedTask = "review the final release evidence";
    await alphaComposer.fill(`${mentionValue}${delegatedTask}`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const handoff = page.getByRole("article", { name: `Bot handoff: ${delegatedTask}` });
    await handoff.waitFor({ state: "visible", timeout: 5_000 });
    await handoff.locator(".bot-delegation-status").filter({ hasText: "Working" })
      .waitFor({ state: "visible" });
    const delegatedRun = await waitForProviderRun(botB, runB2);
    const delegatedSnapshot = await fixtureSnapshot();
    const delegatedRecord = delegatedSnapshot.delegations.find((candidate) => (
      candidate.parentBotId === "bot-alpha" && candidate.targets[0]?.botId === botB
    ));
    if (!delegatedRecord || delegatedRecord.targets[0].maxActions !== 4) {
      throw new Error("The reviewed bot handoff did not persist its bounded target snapshot.");
    }
    const delegatedProvider = delegatedSnapshot.providerRuns.find((run) => run.runId === delegatedRun);
    if (!delegatedProvider?.prompt.includes("do not delegate further")) {
      throw new Error("The delegated provider prompt lost its bounded collaboration policy.");
    }
    await page.evaluate(({ runId }) => {
      window.__CODELIT_PARALLEL_QA__.complete(runId, "Release evidence is complete and ready for approval.");
    }, { runId: delegatedRun });
    await handoff.getByText("Combined result", { exact: true }).waitFor({ state: "visible", timeout: 5_000 });
    await handoff.getByText("Release evidence is complete and ready for approval.", { exact: true })
      .waitFor({ state: "visible" });

    await page.addScriptTag({ content: axe.source });
    consoleIssues.length = 0;
    const handoffAudit = await auditCurrentSurface(page, matrix, "Bot handoff", consoleIssues);
    records.push(handoffAudit);
    failures.push(...handoffAudit.issues.map((issue) => `${matrix.id}/Bot handoff: ${issue}`));
    await page.screenshot({ path: resolve(outputDirectory, "bot-handoff.png") });
    screenshots.push("bot-handoff.png");

    const approvalTask = "inspect https://codelit.io and report the visible release status";
    await alphaComposer.fill(`@${betaName} ${approvalTask}`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const approvalHandoff = page.getByRole("article", { name: `Bot handoff: ${approvalTask}` });
    await approvalHandoff.waitFor({ state: "visible", timeout: 5_000 });
    await approvalHandoff.locator(".bot-delegation-status").filter({ hasText: "Needs approval" })
      .waitFor({ state: "visible", timeout: 5_000 });
    const approvalDelegation = (await fixtureSnapshot()).delegations.find((candidate) => (
      candidate.task === approvalTask
    ));
    if (approvalDelegation?.targets[0]?.status !== "awaiting-approval") {
      throw new Error("The delegated website request did not pause in the reviewed handoff ledger.");
    }
    await approvalHandoff.getByRole("button", { name: "Review", exact: true }).click();
    const delegatedApproval = page.getByRole("region", { name: "Read codelit.io?" });
    await delegatedApproval.waitFor({ state: "visible", timeout: 5_000 });
    consoleIssues.length = 0;
    const delegatedApprovalAudit = await auditCurrentSurface(
      page,
      matrix,
      "Bot handoff approval",
      consoleIssues,
    );
    records.push(delegatedApprovalAudit);
    failures.push(...delegatedApprovalAudit.issues.map((issue) => (
      `${matrix.id}/Bot handoff approval: ${issue}`
    )));
    await page.screenshot({ path: resolve(outputDirectory, "bot-handoff-approval.png") });
    screenshots.push("bot-handoff-approval.png");
    await delegatedApproval.getByRole("button", { name: "Hold", exact: true }).click();
    await delegatedApproval.waitFor({ state: "detached", timeout: 5_000 });
    await botRow("Alpha").click();
    await approvalHandoff.locator(".bot-delegation-status").filter({ hasText: "Stopped" })
      .waitFor({ state: "visible", timeout: 5_000 });
    const heldDelegation = (await fixtureSnapshot()).delegations.find((candidate) => (
      candidate.task === approvalTask
    ));
    if (heldDelegation?.status !== "canceled") {
      throw new Error("Holding delegated website access did not close only that handoff.");
    }

    const canceledTask = "prepare a second release summary for cancellation review";
    await alphaComposer.fill(`Ask the team to ${canceledTask}`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const canceledHandoff = page.getByRole("article", { name: `Bot handoff: ${canceledTask}` });
    await canceledHandoff.waitFor({ state: "visible", timeout: 5_000 });
    await canceledHandoff.locator(".bot-delegation-status").filter({ hasText: "Working" })
      .waitFor({ state: "visible", timeout: 5_000 });
    const cancelSnapshot = await fixtureSnapshot();
    const cancelDelegation = cancelSnapshot.delegations.find((candidate) => candidate.task === canceledTask);
    const canceledRunId = cancelDelegation?.targets[0]?.runId;
    if (!canceledRunId) throw new Error("The cancelable handoff did not start its specialist run.");
    await canceledHandoff.getByRole("button", { name: "Stop handoff", exact: true }).click();
    await canceledHandoff.locator(".bot-delegation-status").filter({ hasText: "Stopped" })
      .waitFor({ state: "visible", timeout: 5_000 });
    const afterDelegationCancel = await fixtureSnapshot();
    if (afterDelegationCancel.providerRuns.find((run) => run.runId === canceledRunId)?.settled !== "canceled"
      || !afterDelegationCancel.cancelCalls.includes(canceledRunId)) {
      throw new Error("Stopping a handoff did not cancel its owned provider run.");
    }
    await page.screenshot({ path: resolve(outputDirectory, "bot-handoff-stopped.png") });
    screenshots.push("bot-handoff-stopped.png");

    await page.getByRole("button", { name: "All activity", exact: false }).click();
    await page.getByRole("heading", { name: "All activity", exact: true }).waitFor({ state: "visible" });
    await page.getByText("Morning release check", { exact: true }).waitFor({ state: "visible" });
    await page.getByText("Alpha asked", { exact: true }).first().waitFor({ state: "visible" });
    if (await page.locator(".bots-composer").count()) {
      throw new Error("All activity kept a bot-specific composer visible.");
    }
    await page.screenshot({ path: resolve(outputDirectory, "all-activity.png") });
    screenshots.push("all-activity.png");
  } finally {
    await context.close();
  }
}

async function auditMcpChatAction(browser, url, matrix, records, failures, screenshots) {
  const context = await browser.newContext({
    viewport: { width: matrix.width, height: matrix.height },
    colorScheme: matrix.colorScheme,
    locale: matrix.locale,
    reducedMotion: "reduce",
  });
  await context.addInitScript(installParallelBotTauriFixture, {
    packagedSkillManifests: builtinSkillManifests,
    enableMcp: true,
  });
  const page = await context.newPage();
  const consoleIssues = [];
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type())) consoleIssues.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));
  const snapshot = () => page.evaluate(() => window.__CODELIT_PARALLEL_QA__.snapshot());
  const activeRun = async (attempt = 1, runId = null) => {
    await page.waitForFunction(({ expectedAttempt, expectedRunId }) => {
      const current = window.__CODELIT_PARALLEL_QA__.snapshot();
      return current.providerRuns.some((run) => (
        run.owner?.botId === "bot-alpha"
        && run.settled === null
        && run.attempt === expectedAttempt
        && (!expectedRunId || run.runId === expectedRunId)
      ));
    }, { expectedAttempt: attempt, expectedRunId: runId }, { timeout: 5_000 });
    const current = await snapshot();
    const run = current.providerRuns.find((candidate) => (
      candidate.owner?.botId === "bot-alpha"
      && candidate.settled === null
      && candidate.attempt === attempt
      && (!runId || candidate.runId === runId)
    ));
    if (!run) throw new Error(`The MCP provider attempt ${attempt} was not created.`);
    return run.runId;
  };
  const request = "Send Release candidate 12 is ready. to Slack channel #release.";
  const argumentsJson = { channel: "#release", text: "Release candidate 12 is ready." };
  const proposeMcpCall = async () => {
    const composer = page.getByLabel("Message Alpha");
    await composer.fill(request);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const runId = await activeRun();
    await page.evaluate(({ id, args }) => {
      window.__CODELIT_PARALLEL_QA__.completeWithItems(id, "Preparing the reviewed Slack call.", [
        "ACTION:mcp:mcp::slack-local::send_message",
        `ARGUMENTS:${JSON.stringify(args)}`,
      ]);
    }, { id: runId, args: argumentsJson });
    const approval = page.getByRole("region", { name: "Allow this external action?" });
    await approval.waitFor({ state: "visible", timeout: 5_000 });
    return { approval, runId };
  };

  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.locator(".bots-thread").waitFor({ state: "visible", timeout: 4_000 });
    await page.getByLabel("Message Alpha").waitFor({ state: "visible" });

    const heldProposal = await proposeMcpCall();
    const approvalText = await heldProposal.approval.textContent();
    const beforeHold = await snapshot();
    const preparedHold = beforeHold.mcpApprovals.find((entry) => entry.runId === heldProposal.runId);
    if (!approvalText?.includes("Slack / send_message")
      || !approvalText.includes('\"channel\": \"#release\"')
      || !approvalText.includes('\"text\": \"Release candidate 12 is ready.\"')
      || !approvalText.includes("Effect: write")
      || beforeHold.mcpActions.length !== 0
      || JSON.stringify(preparedHold?.arguments) !== JSON.stringify(argumentsJson)) {
      throw new Error("The MCP approval did not expose the exact typed call before execution.");
    }
    await page.addScriptTag({ content: axe.source });
    consoleIssues.length = 0;
    const approvalAudit = await auditCurrentSurface(page, matrix, "MCP action approval", consoleIssues);
    records.push(approvalAudit);
    failures.push(...approvalAudit.issues.map((issue) => `${matrix.id}/MCP action approval: ${issue}`));
    const approvalScreenshot = matrix.width < 900
      ? "mcp-action-approval-compact.png"
      : "mcp-action-approval.png";
    await page.screenshot({ path: resolve(outputDirectory, approvalScreenshot) });
    screenshots.push(approvalScreenshot);

    await heldProposal.approval.getByRole("button", { name: "Hold", exact: true }).click();
    await heldProposal.approval.waitFor({ state: "detached", timeout: 5_000 });
    await page.locator(".bot-message.assistant")
      .filter({ hasText: "No external action ran." })
      .waitFor({ state: "visible", timeout: 5_000 });
    const afterHold = await snapshot();
    if (afterHold.mcpActions.length !== 0 || afterHold.preparedMcpRunIds.includes(heldProposal.runId)) {
      throw new Error("Holding the MCP proposal invoked or retained the external action.");
    }

    const approvedProposal = await proposeMcpCall();
    const preparedApproval = (await snapshot()).mcpApprovals.find((entry) => entry.runId === approvedProposal.runId);
    await approvedProposal.approval.getByRole("button", { name: "Allow once", exact: true }).click();
    const followUpRunId = await activeRun(2, approvedProposal.runId);
    const duringFollowUp = await snapshot();
    const action = duringFollowUp.mcpActions.find((entry) => entry.runId === approvedProposal.runId);
    if (duringFollowUp.mcpActions.length !== 1
      || action?.approvalSha256 !== preparedApproval?.approvalSha256
      || action?.toolReference !== "mcp::slack-local::send_message"
      || JSON.stringify(action?.arguments) !== JSON.stringify(argumentsJson)
      || duringFollowUp.preparedMcpRunIds.includes(approvedProposal.runId)) {
      throw new Error("Allow once did not execute exactly the sealed typed MCP call once.");
    }
    await page.evaluate(({ id }) => {
      window.__CODELIT_PARALLEL_QA__.complete(id, "Posted the release update to #release.");
    }, { id: followUpRunId });
    await page.locator(".bot-message.assistant")
      .filter({ hasText: "Posted the release update to #release." })
      .waitFor({ state: "visible", timeout: 5_000 });
    const completed = await snapshot();
    const receipt = completed.receipts.find((entry) => entry.runId === approvedProposal.runId);
    if (completed.mcpActions.length !== 1
      || receipt?.body?.status !== "completed"
      || receipt?.body?.details?.approval?.scope !== "typed-mcp-action"
      || receipt?.body?.details?.approval?.approvalSha256 !== preparedApproval?.approvalSha256
      || JSON.stringify(receipt?.body?.details?.mcp?.arguments) !== JSON.stringify(argumentsJson)) {
      throw new Error("The completed MCP action lost its exact approval or receipt boundary.");
    }
    consoleIssues.length = 0;
    const completionAudit = await auditCurrentSurface(page, matrix, "MCP action completion", consoleIssues);
    records.push(completionAudit);
    failures.push(...completionAudit.issues.map((issue) => `${matrix.id}/MCP action completion: ${issue}`));
    const completedScreenshot = matrix.width < 900
      ? "mcp-action-complete-compact.png"
      : "mcp-action-complete.png";
    await page.screenshot({ path: resolve(outputDirectory, completedScreenshot) });
    screenshots.push(completedScreenshot);
  } finally {
    await context.close();
  }
}

async function auditCompactBotHandoff(browser, url, records, failures, screenshots) {
  const matrix = matrices.find((candidate) => candidate.id === "minimum-light");
  if (!matrix) throw new Error("The minimum-light renderer matrix is unavailable.");
  const context = await browser.newContext({
    viewport: { width: matrix.width, height: matrix.height },
    colorScheme: matrix.colorScheme,
    locale: matrix.locale,
    reducedMotion: "reduce",
  });
  await context.addInitScript(installParallelBotTauriFixture, builtinSkillManifests);
  const page = await context.newPage();
  const consoleIssues = [];
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type())) consoleIssues.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));
  const snapshot = () => page.evaluate(() => window.__CODELIT_PARALLEL_QA__.snapshot());

  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.getByLabel("Message Alpha").waitFor({ state: "visible", timeout: 4_000 });
    const openSidebar = page.getByRole("button", { name: "Open sidebar", exact: true });
    if (await openSidebar.isVisible()) await openSidebar.click();
    await page.getByRole("button", { name: "New bot", exact: true }).click();
    const newBot = page.getByRole("dialog", { name: "Create a bot" });
    await page.getByLabel("Bot job").fill("Review compact handoffs.");
    await newBot.getByRole("button", { name: "Create bot", exact: true }).click();
    await newBot.waitFor({ state: "detached" });
    const targetName = "Review Compact Handoffs Bot";
    const created = await snapshot();
    const targetId = created.activeBotId;
    if (!targetId || targetId === "bot-alpha") throw new Error("Compact QA did not create its specialist bot.");
    await page.waitForFunction((id) => window.__CODELIT_PARALLEL_QA__.snapshot().providerRuns.some((run) => (
      run.owner?.botId === id && run.settled === null
    )), targetId, { timeout: 5_000 });
    const starting = await snapshot();
    const startupRunId = starting.providerRuns.find((run) => (
      run.owner?.botId === targetId && run.settled === null
    ))?.runId;
    if (!startupRunId) throw new Error("Compact QA did not capture the specialist's automatic first action.");

    if (await openSidebar.isVisible()) await openSidebar.click();
    await page.locator(".bots-roster > button").filter({ hasText: "Alpha" }).first().click();
    await page.getByLabel("Message Alpha").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Add conversation teammates", exact: true }).click();
    const teamDialog = page.getByRole("dialog", { name: "Conversation team" });
    await teamDialog.getByRole("checkbox", { name: `Add ${targetName}`, exact: true }).check();
    await page.addScriptTag({ content: axe.source });
    consoleIssues.length = 0;
    const teamAudit = await auditCurrentSurface(page, matrix, "Conversation team", consoleIssues);
    records.push(teamAudit);
    failures.push(...teamAudit.issues.map((issue) => `${matrix.id}/Conversation team: ${issue}`));
    await page.screenshot({ path: resolve(outputDirectory, "conversation-team-compact.png") });
    screenshots.push("conversation-team-compact.png");
    await teamDialog.getByRole("button", { name: "Save team", exact: true }).click();
    await teamDialog.waitFor({ state: "detached" });
    const task = "check the compact release summary";
    await page.getByLabel("Message Alpha").fill(`Ask the team to ${task}`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const handoff = page.getByRole("article", { name: `Bot handoff: ${task}` });
    await handoff.waitFor({ state: "visible", timeout: 5_000 });
    await handoff.locator(".bot-delegation-status").filter({ hasText: "Queued" })
      .waitFor({ state: "visible", timeout: 5_000 });
    const queued = await snapshot();
    const queuedTarget = queued.delegations.at(0)?.targets.find((target) => target.botId === targetId);
    if (queuedTarget?.status !== "queued") {
      throw new Error("A busy specialist was not kept in the reviewed handoff queue.");
    }
    await page.evaluate(({ runId }) => {
      window.__CODELIT_PARALLEL_QA__.complete(runId, "Compact specialist is ready.");
    }, { runId: startupRunId });
    await page.waitForFunction((id) => window.__CODELIT_PARALLEL_QA__.snapshot().delegations.some((delegation) => (
      delegation.targets.some((target) => target.botId === id && target.status === "running" && target.runId)
    )), targetId, { timeout: 8_000 });
    const running = await snapshot();
    const runId = running.delegations.at(0)?.targets.find((target) => target.botId === targetId)?.runId;
    if (!runId || runId === startupRunId) throw new Error("Compact QA did not start its queued delegated provider run.");
    await page.evaluate((id) => {
      window.__CODELIT_PARALLEL_QA__.complete(id, "Compact handoff is readable and complete.");
    }, runId);
    await page.waitForFunction((id) => window.__CODELIT_PARALLEL_QA__.snapshot().delegations.some((delegation) => (
      delegation.targets.some((target) => target.botId === id && target.status === "completed")
    )), targetId, { timeout: 8_000 }).catch(async (error) => {
      throw new Error(`Compact delegated run did not finish in the ledger: ${error.message}\n${JSON.stringify(await snapshot())}`);
    });
    await handoff.getByText("Compact handoff is readable and complete.", { exact: true })
      .waitFor({ state: "visible", timeout: 8_000 }).catch(async (error) => {
        throw new Error(`Compact delegated result did not render: ${error.message}\n${JSON.stringify(await snapshot())}`);
      });
    await page.addScriptTag({ content: axe.source });
    consoleIssues.length = 0;
    const audit = await auditCurrentSurface(page, matrix, "Bot handoff", consoleIssues);
    records.push(audit);
    failures.push(...audit.issues.map((issue) => `${matrix.id}/Bot handoff: ${issue}`));
    await page.screenshot({ path: resolve(outputDirectory, "bot-handoff-compact.png") });
    screenshots.push("bot-handoff-compact.png");

    await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
    await page.getByRole("button", { name: "All activity", exact: false }).click();
    await page.getByRole("heading", { name: "All activity", exact: true }).waitFor({ state: "visible" });
    const activityOverflow = await page.evaluate(() => (
      document.documentElement.scrollWidth - document.documentElement.clientWidth
    ));
    if (activityOverflow > 1) failures.push(`minimum-light/All activity: horizontal overflow ${activityOverflow}px`);
    await page.screenshot({ path: resolve(outputDirectory, "all-activity-compact.png") });
    screenshots.push("all-activity-compact.png");
  } finally {
    await context.close();
  }
}

async function auditBotProfileAndMarkdown(browser, url, matrix, records, failures, screenshots) {
  const compact = matrix.id === "minimum-light";
  const context = await browser.newContext({
    viewport: { width: matrix.width, height: matrix.height },
    colorScheme: matrix.colorScheme,
    locale: matrix.locale,
    reducedMotion: "reduce",
  });
  await context.addInitScript(installParallelBotTauriFixture, builtinSkillManifests);
  const page = await context.newPage();
  const consoleIssues = [];
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type())) consoleIssues.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));

  const fixtureSnapshot = () => page.evaluate(() => window.__CODELIT_PARALLEL_QA__.snapshot());
  const activeProviderRun = (botId) => page.evaluate((id) => {
    const snapshot = window.__CODELIT_PARALLEL_QA__.snapshot();
    return snapshot.providerRuns.find((run) => run.owner?.botId === id && run.settled === null)?.runId || null;
  }, botId);
  const waitForProviderRun = async (botId) => {
    await page.waitForFunction((id) => {
      const snapshot = window.__CODELIT_PARALLEL_QA__.snapshot();
      return snapshot.providerRuns.some((run) => run.owner?.botId === id && run.settled === null);
    }, botId, { timeout: 5_000 });
    const runId = await activeProviderRun(botId);
    if (!runId) throw new Error(`A provider barrier was not created for ${botId}.`);
    return runId;
  };
  const sidebar = page.locator('aside[aria-label="Bots"]');
  const botRow = (name) => sidebar.locator(".bots-roster > button").filter({ hasText: name }).first();
  const ensureSidebarOpen = async () => {
    const open = page.getByRole("button", { name: "Open sidebar", exact: true });
    if (await open.isVisible()) await open.click();
    await sidebar.waitFor({ state: "visible" });
    if (await sidebar.getAttribute("aria-hidden") === "true") {
      throw new Error("The bot drawer stayed hidden after it was opened.");
    }
  };
  const chooseBot = async (name) => {
    await ensureSidebarOpen();
    const row = botRow(name);
    await row.waitFor({ state: "visible" });
    if (await row.isDisabled()) throw new Error(`${name} could not be selected during profile QA.`);
    await row.click();
    await page.locator(".bots-title strong").filter({ hasText: name }).waitFor({ state: "visible" });
  };
  const addAudit = async (surface) => {
    const audit = await auditCurrentSurface(page, matrix, surface, consoleIssues);
    records.push(audit);
    failures.push(...audit.issues.map((issue) => `${matrix.id}/${surface}: ${issue}`));
  };
  const markdownAnswer = [
    "## Secure rollout",
    "",
    "- Keep MCP credentials read only.",
    "- Audit every database query.",
    "",
    "| Layer | Control |",
    "| --- | --- |",
    "| MCP | Least privilege |",
    "| Database | Network allowlist |",
    "",
    "```sql",
    "BEGIN READ ONLY;",
    "SELECT current_user, current_database(), current_setting('server_version');",
    "```",
  ].join("\n");

  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.locator(".bots-thread").waitFor({ state: "visible", timeout: 4_000 });
    await page.getByLabel("Message Alpha").waitFor({ state: "visible" });
    await page.addScriptTag({ content: axe.source });

    await page.getByLabel("Message Alpha").fill("Keep Alpha running while I customize another bot.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const runA = await waitForProviderRun("bot-alpha");
    await page.evaluate((runId) => {
      window.__CODELIT_PARALLEL_QA__.emit(
        runId,
        "reasoning-delta",
        "Alpha is holding its independent provider lane. ",
      );
      window.__CODELIT_PARALLEL_QA__.emit(
        runId,
        "reasoning-delta",
        "Alpha keeps running during the profile edit.",
      );
    }, runA);

    if (compact) {
      const open = page.getByRole("button", { name: "Open sidebar", exact: true });
      await open.waitFor({ state: "visible" });
      if (await sidebar.getAttribute("aria-hidden") !== "true" || !(await sidebar.getAttribute("inert") !== null)) {
        throw new Error("The 760px bot drawer was not hidden and inert before opening.");
      }
      await open.click();
      await page.getByRole("button", { name: "Close sidebar", exact: true }).waitFor({ state: "visible" });
      const drawerLayout = await page.evaluate(() => {
        const drawer = document.querySelector(".bots-sidebar");
        const main = document.querySelector(".bots-main");
        const scrim = document.querySelector(".bots-sidebar-scrim");
        const drawerBounds = drawer?.getBoundingClientRect();
        const mainBounds = main?.getBoundingClientRect();
        return {
          drawerPosition: drawer ? getComputedStyle(drawer).position : "",
          drawerWidth: drawerBounds?.width || 0,
          mainLeft: mainBounds?.left || 0,
          mainWidth: mainBounds?.width || 0,
          scrimVisible: Boolean(scrim && getComputedStyle(scrim).display !== "none"),
        };
      });
      if (
        drawerLayout.drawerPosition !== "fixed"
        || drawerLayout.drawerWidth <= 0
        || drawerLayout.drawerWidth > matrix.width - 44 + 1
        || Math.abs(drawerLayout.mainLeft) > 1
        || Math.abs(drawerLayout.mainWidth - matrix.width) > 1
        || !drawerLayout.scrimVisible
      ) {
        throw new Error(`The 760px bot drawer geometry is invalid: ${JSON.stringify(drawerLayout)}`);
      }
      consoleIssues.length = 0;
      await addAudit("Compact drawer");
    } else {
      await ensureSidebarOpen();
    }

    const newBotButton = page.getByRole("button", { name: "New bot", exact: true });
    await newBotButton.waitFor({ state: "visible" });
    if (await newBotButton.isDisabled()) {
      throw new Error("New bot was disabled while Alpha's provider lane was active.");
    }
    await newBotButton.click();
    const newBot = page.getByRole("dialog", { name: "Create a bot" });
    await newBot.waitFor({ state: "visible" });
    await newBot.getByText("Customize", { exact: true }).click();
    await newBot.getByLabel("Name", { exact: true }).fill("Beta");
    await newBot.getByLabel("Bot job", { exact: true }).fill("Render technical rollout answers.");
    await newBot.getByRole("button", { name: "Create bot", exact: true }).click();
    await newBot.waitFor({ state: "detached" });
    await page.locator(".bots-title strong").filter({ hasText: "Beta" }).waitFor({ state: "visible" });
    const created = await fixtureSnapshot();
    const botB = created.activeBotId;
    if (!botB || botB === "bot-alpha") throw new Error("The profile QA bot was not created and selected.");

    if (compact) {
      await page.getByRole("button", { name: "Close sidebar", exact: true }).click();
      await page.getByRole("button", { name: "Open sidebar", exact: true }).waitFor({ state: "visible" });
    }

    const identityTrigger = page.getByRole("button", { name: "Customize Beta", exact: true });
    await identityTrigger.waitFor({ state: "visible" });
    await identityTrigger.click();
    const profile = page.getByRole("dialog", { name: "Customize Beta" });
    const profileName = profile.locator("#bot-profile-name");
    await profile.waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const input = document.querySelector("#bot-profile-name");
      return input instanceof HTMLInputElement
        && document.activeElement === input
        && input.selectionStart === 0
        && input.selectionEnd === input.value.length;
    });
    const backgroundIsInert = await page.evaluate(() => (
      document.querySelector(".bots-main")?.hasAttribute("inert") === true
      && document.querySelector(".bots-sidebar")?.hasAttribute("inert") === true
    ));
    if (!backgroundIsInert) throw new Error("Opening the bot profile did not make the background inert.");

    const closeProfile = profile.getByRole("button", { name: "Close profile", exact: true });
    const saveProfile = profile.getByRole("button", { name: "Save profile", exact: true });
    await closeProfile.focus();
    await page.keyboard.press("Shift+Tab");
    if (!(await saveProfile.evaluate((element) => document.activeElement === element))) {
      throw new Error("Shift+Tab escaped the bot profile instead of wrapping to its last control.");
    }
    await page.keyboard.press("Tab");
    if (!(await closeProfile.evaluate((element) => document.activeElement === element))) {
      throw new Error("Tab escaped the bot profile instead of wrapping to its first control.");
    }
    await page.keyboard.press("Escape");
    await profile.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Customize Beta");

    await identityTrigger.click();
    await profile.waitFor({ state: "visible" });
    await profileName.fill("Beta Beacon");
    const wave = profile.getByRole("radio", { name: "Wave", exact: true });
    await wave.click();
    if (await wave.getAttribute("aria-checked") !== "true") {
      throw new Error("The Wave avatar preset did not become selected.");
    }
    consoleIssues.length = 0;
    await addAudit("Bot profile");
    const profileScreenshot = compact ? "bot-profile-compact.png" : "bot-profile.png";
    await page.screenshot({ path: resolve(outputDirectory, profileScreenshot) });
    screenshots.push(profileScreenshot);
    await profile.getByRole("button", { name: "Save profile", exact: true }).click();
    await profile.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Customize Beta Beacon", exact: true })
      .waitFor({ state: "visible" });

    const afterProfile = await fixtureSnapshot();
    const profileUpdate = afterProfile.profileUpdates.at(-1);
    const renamedBot = afterProfile.bots.find((candidate) => candidate.id === botB);
    if (
      afterProfile.profileUpdates.length !== 1
      || profileUpdate?.id !== botB
      || profileUpdate?.name !== "Beta Beacon"
      || profileUpdate?.avatar?.kind !== "preset"
      || profileUpdate?.avatar?.preset !== "wave"
      || typeof profileUpdate?.updatedAt !== "string"
      || renamedBot?.name !== "Beta Beacon"
      || renamedBot?.spec.name !== "Beta Beacon"
      || renamedBot?.spec.appearance?.avatar?.preset !== "wave"
      || renamedBot?.currentVersion !== 2
    ) {
      throw new Error(`The native bot profile contract did not persist atomically: ${JSON.stringify(afterProfile)}`);
    }
    if (afterProfile.providerRuns.find((run) => run.runId === runA)?.settled !== null) {
      throw new Error("Saving Beta's profile stopped Alpha's provider lane.");
    }

    if (compact) {
      await ensureSidebarOpen();
      await botRow("Beta Beacon").locator(".bot-row-copy strong").filter({ hasText: "Beta Beacon" })
        .waitFor({ state: "visible" });
      await botRow("Alpha").locator(".bot-row-copy strong").filter({ hasText: "Alpha" })
        .waitFor({ state: "visible" });
      await page.screenshot({ path: resolve(outputDirectory, "compact-drawer.png") });
      screenshots.push("compact-drawer.png");
    }

    await chooseBot("Alpha");
    await page.locator(".bot-live-thinking").filter({ hasText: "Alpha keeps running during the profile edit." })
      .waitFor({ state: "visible" });
    await chooseBot("Beta Beacon");
    const renamedTrigger = page.getByRole("button", { name: "Customize Beta Beacon", exact: true });
    await renamedTrigger.locator(".bot-avatar-wave").waitFor({ state: "visible" });
    await page.getByRole("heading", { name: "Beta Beacon", level: 1 }).waitFor({ state: "visible" });
    const afterSwitch = await fixtureSnapshot();
    if (afterSwitch.providerRuns.find((run) => run.runId === runA)?.settled !== null) {
      throw new Error("Switching away from the renamed bot stopped Alpha's provider lane.");
    }

    await page.getByLabel("Message Beta Beacon").fill("Remember that staging uses the test workspace");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const remembered = page.getByRole("region", { name: "New bot memory", exact: true });
    await remembered.waitFor({ state: "visible" });
    await remembered.getByText("staging uses the test workspace", { exact: true }).waitFor({ state: "visible" });
    const afterRemember = await fixtureSnapshot();
    if (
      afterRemember.memories.length !== 1
      || afterRemember.memories[0].botId !== botB
      || afterRemember.memories[0].body !== "staging uses the test workspace"
      || afterRemember.memories[0].approvalState !== "approved"
    ) {
      throw new Error(`Chat memory was not approved and scoped to Beta: ${JSON.stringify(afterRemember.memories)}`);
    }
    await page.getByLabel("Message Beta Beacon").fill("What do you know?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.locator(".bot-message.assistant")
      .filter({ hasText: "This bot: staging uses the test workspace" })
      .last()
      .waitFor({ state: "visible" });
    consoleIssues.length = 0;
    await addAudit("Bot memory");
    const memoryScreenshot = compact ? "bot-memory-compact.png" : "bot-memory.png";
    await page.screenshot({ path: resolve(outputDirectory, memoryScreenshot) });
    screenshots.push(memoryScreenshot);

    await page.getByLabel("Message Beta Beacon").fill("Use the approved environment context in a short answer.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const memoryRun = await waitForProviderRun(botB);
    const duringMemoryRun = await fixtureSnapshot();
    const groundedPrompt = duringMemoryRun.providerRuns.find((run) => run.runId === memoryRun)?.prompt || "";
    if (!groundedPrompt.includes("Bot memory (fact): staging uses the test workspace")) {
      throw new Error("The next provider run was not grounded in the approved memory snapshot.");
    }
    await page.evaluate((runId) => {
      window.__CODELIT_PARALLEL_QA__.complete(runId, "I used the approved staging context.");
    }, memoryRun);
    await page.locator(".bot-message.assistant").filter({ hasText: "I used the approved staging context." })
      .waitFor({ state: "visible", timeout: 5_000 });
    await remembered.getByRole("button", { name: "Undo", exact: true }).click();
    await remembered.waitFor({ state: "detached" });
    const afterUndo = await fixtureSnapshot();
    if (afterUndo.memories.length !== 0) {
      throw new Error("Undo did not remove the newly taught bot memory.");
    }

    await page.getByLabel("Message Beta Beacon")
      .fill("I prefer concise release summaries. Apply that preference to this update.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const proposalRun = await waitForProviderRun(botB);
    await page.evaluate((runId) => {
      window.__CODELIT_PARALLEL_QA__.complete(runId, "I kept the release summary concise.");
    }, proposalRun);
    const memorySuggestions = page.getByRole("region", { name: "Memory suggestions", exact: true });
    await memorySuggestions.waitFor({ state: "visible" });
    await memorySuggestions.getByText("I prefer concise release summaries", { exact: true })
      .waitFor({ state: "visible" });
    await memorySuggestions.getByLabel("Memory scope", { exact: true }).selectOption("workspace");
    await memorySuggestions.getByLabel("Memory retention", { exact: true }).selectOption("90");
    consoleIssues.length = 0;
    await addAudit("Memory proposal review");
    const proposalScreenshot = compact ? "bot-memory-proposal-compact.png" : "bot-memory-proposal.png";
    await page.screenshot({ path: resolve(outputDirectory, proposalScreenshot) });
    screenshots.push(proposalScreenshot);
    await memorySuggestions.getByRole("button", { name: "Remember", exact: true }).click();
    await memorySuggestions.waitFor({ state: "detached" });
    const afterProposal = await fixtureSnapshot();
    const approvedSuggestion = afterProposal.memories.find((memory) => memory.source === "inferred");
    if (
      afterProposal.memoryProposals.length !== 0
      || approvedSuggestion?.scope !== "workspace"
      || approvedSuggestion?.sourceRunId !== proposalRun
      || !approvedSuggestion?.expiresAt
    ) {
      throw new Error(`Memory proposal review did not preserve provenance and expiry: ${JSON.stringify(afterProposal)}`);
    }
    const approvedSuggestionCard = page.getByRole("region", { name: "New bot memory", exact: true });
    await approvedSuggestionCard.getByRole("button", { name: "Undo", exact: true }).click();
    await approvedSuggestionCard.waitFor({ state: "detached" });

    await page.getByLabel("Message Beta Beacon")
      .fill("Teach a skill called Release Check: Summarize release evidence and name the single riskiest gap");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const taughtSkill = page.getByRole("region", { name: "New reusable skill", exact: true });
    await taughtSkill.waitFor({ state: "visible" });
    await taughtSkill.getByText("Learned Release Check", { exact: true }).waitFor({ state: "visible" });
    const afterTeach = await fixtureSnapshot();
    const releaseSkill = afterTeach.skills.find((skill) => skill.name === "Release Check");
    if (
      afterTeach.skills.length !== 3
      || releaseSkill?.version !== 1
      || releaseSkill?.trustState !== "reviewed"
      || afterTeach.skills.filter((skill) => skill.source === "built-in").length !== 2
    ) {
      throw new Error(`Chat skill was not reviewed and shared with the workspace: ${JSON.stringify(afterTeach.skills)}`);
    }
    await page.getByLabel("Message Beta Beacon").fill("Show skills");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.locator(".bot-message.assistant")
      .filter({ hasText: "Release Check" })
      .last()
      .waitFor({ state: "visible" });
    consoleIssues.length = 0;
    await addAudit("Bot skills");
    const skillScreenshot = compact ? "bot-skills-compact.png" : "bot-skills.png";
    await page.screenshot({ path: resolve(outputDirectory, skillScreenshot) });
    screenshots.push(skillScreenshot);

    await page.getByLabel("Message Beta Beacon").fill("Use Release Check for the current release.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const skillRun = await waitForProviderRun(botB);
    const duringSkillRun = await fixtureSnapshot();
    const skillPrompt = duringSkillRun.providerRuns.find((run) => run.runId === skillRun)?.prompt || "";
    if (!skillPrompt.includes('Reusable skill "Release Check" v1')) {
      throw new Error("The provider run was not pinned to the reviewed reusable skill version.");
    }
    await page.evaluate((runId) => {
      window.__CODELIT_PARALLEL_QA__.complete(runId, "The release check used its reviewed instructions.");
    }, skillRun);
    await page.locator(".bot-message.assistant")
      .filter({ hasText: "The release check used its reviewed instructions." })
      .waitFor({ state: "visible", timeout: 5_000 });
    await taughtSkill.getByRole("button", { name: "Undo", exact: true }).click();
    await taughtSkill.waitFor({ state: "detached" });
    const afterSkillUndo = await fixtureSnapshot();
    if (afterSkillUndo.skills.length !== 2
      || afterSkillUndo.skills.some((skill) => skill.source !== "built-in")) {
      throw new Error("Undo did not remove the newly taught reusable skill.");
    }

    await page.getByLabel("Message Beta Beacon").fill("Import a skill package");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const importedSkillReview = page.getByRole("region", {
      name: "Imported skills waiting for review",
      exact: true,
    });
    await importedSkillReview.waitFor({ state: "visible" });
    await importedSkillReview.getByText("Issue brief", { exact: true }).waitFor({ state: "visible" });
    await importedSkillReview.getByText("Use only the supplied issue text and return one next action.", { exact: true })
      .waitFor({ state: "visible" });
    await importedSkillReview.getByText("Issue · text · required", { exact: true }).waitFor({ state: "visible" });
    await importedSkillReview.getByText("Issue brief · text · required", { exact: true }).waitFor({ state: "visible" });
    await importedSkillReview.getByText("Issue is present, Issue brief is present", { exact: true })
      .waitFor({ state: "visible" });
    await importedSkillReview.getByText("Generate a local brief", { exact: true }).waitFor({ state: "visible" });
    await importedSkillReview.getByText("model-generate · conversation · local", { exact: true })
      .waitFor({ state: "visible" });
    const beforeImportReview = await fixtureSnapshot();
    const pendingImport = beforeImportReview.skills.find((skill) => skill.name === "Issue brief");
    if (pendingImport?.trustState !== "unreviewed") {
      throw new Error(`Imported skill did not remain inert before review: ${JSON.stringify(pendingImport)}`);
    }
    consoleIssues.length = 0;
    await addAudit("Imported skill review");
    const importedSkillScreenshot = compact ? "bot-skill-import-compact.png" : "bot-skill-import.png";
    await page.screenshot({ path: resolve(outputDirectory, importedSkillScreenshot) });
    screenshots.push(importedSkillScreenshot);
    await importedSkillReview.getByRole("button", { name: "Approve skill", exact: true }).click();
    await importedSkillReview.waitFor({ state: "detached" });
    const afterImportReview = await fixtureSnapshot();
    const reviewedImport = afterImportReview.skills.find((skill) => skill.name === "Issue brief");
    if (reviewedImport?.trustState !== "reviewed" || reviewedImport?.version !== 2) {
      throw new Error(`Imported skill review did not create a reviewed version: ${JSON.stringify(reviewedImport)}`);
    }
    await page.getByLabel("Message Beta Beacon").fill("Run Issue brief with issue: Slow first launch");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const importedSkillRun = await waitForProviderRun(botB);
    const duringImportedSkillRun = await fixtureSnapshot();
    const importedPrompt = duringImportedSkillRun.providerRuns
      .find((run) => run.runId === importedSkillRun)?.prompt || "";
    if (!importedPrompt.includes('Skill contract for "Issue brief" v2')
      || !importedPrompt.includes("Validated inputs: Issue: Slow first launch")) {
      throw new Error("The reviewed imported skill did not bind its typed input contract to the run.");
    }
    await page.evaluate((runId) => {
      window.__CODELIT_PARALLEL_QA__.complete(runId, "First launch is blocked by an unbounded cache warmup.");
    }, importedSkillRun);
    await page.locator(".bot-message.assistant")
      .filter({ hasText: "First launch is blocked" })
      .waitFor({ state: "visible", timeout: 5_000 });
    const afterImportedSkillRun = await fixtureSnapshot();
    const importedReceipt = afterImportedSkillRun.receipts.find((receipt) => (
      receipt.runId === importedSkillRun
    ));
    const importedContract = importedReceipt?.body?.details?.skillContracts?.[0];
    if (importedContract?.skillId !== reviewedImport.id
      || importedContract?.checks?.some((check) => !check.passed)
      || JSON.stringify(importedContract).includes("Slow first launch")) {
      throw new Error(`Imported skill receipt was incomplete or retained raw inputs: ${JSON.stringify(importedContract)}`);
    }
    await page.getByLabel("Message Beta Beacon").fill("Forget skill Issue brief");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.locator(".bot-message.assistant")
      .filter({ hasText: "Forgot skill Issue brief" })
      .last()
      .waitFor({ state: "visible" });

    await page.getByLabel("Message Beta Beacon")
      .fill("Teach a browser task called Customer lookup at https://app.example.com/customers");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const browserTeaching = page.getByRole("region", { name: "Teach a browser task", exact: true });
    await browserTeaching.waitFor({ state: "visible" });
    const reviewSteps = browserTeaching.getByRole("button", { name: "Review steps", exact: true });
    await reviewSteps.waitFor({ state: "visible", timeout: 5_000 });
    await reviewSteps.click();
    const checkReplay = browserTeaching.getByRole("button", { name: "Check replay", exact: true });
    await checkReplay.waitFor({ state: "visible" });
    await checkReplay.click();
    const saveBrowserSkill = browserTeaching.getByRole("button", { name: "Save skill", exact: true });
    await saveBrowserSkill.waitFor({ state: "visible", timeout: 5_000 });
    const recordedSteps = browserTeaching.getByLabel("Recorded browser steps", { exact: true });
    await recordedSteps.waitFor({ state: "visible" });
    if (await recordedSteps.getByRole("listitem").count() !== 3) {
      throw new Error("Browser teaching did not present its two reviewed actions and protected takeover step.");
    }
    const replayChecks = browserTeaching.getByRole("group", { name: "Browser replay checks", exact: true });
    await replayChecks.waitFor({ state: "visible" });
    const replayCheckState = await replayChecks.locator("span").evaluateAll((elements) => elements.map((element) => ({
      passed: element.getAttribute("data-passed"),
      text: element.textContent?.trim() || "",
    })));
    if (replayCheckState.length !== 3 || replayCheckState.some((check) => check.passed !== "true")) {
      throw new Error(`Browser teaching replay checks did not all pass: ${JSON.stringify(replayCheckState)}`);
    }
    consoleIssues.length = 0;
    await addAudit("Browser teaching");
    const browserTeachingScreenshot = compact ? "browser-teaching-compact.png" : "browser-teaching.png";
    await page.screenshot({ path: resolve(outputDirectory, browserTeachingScreenshot) });
    screenshots.push(browserTeachingScreenshot);
    await saveBrowserSkill.click();
    await browserTeaching.waitFor({ state: "detached" });
    const browserSkillCard = page.getByRole("region", { name: "New reusable skill", exact: true });
    await browserSkillCard.getByText("Learned Customer lookup", { exact: true }).waitFor({ state: "visible" });
    const afterBrowserTeach = await fixtureSnapshot();
    const browserSkill = afterBrowserTeach.skills.find((skill) => skill.name === "Customer lookup");
    const retainedBrowserValue = JSON.stringify({
      teachings: afterBrowserTeach.browserTeachings,
      skill: browserSkill,
    }).match(/\"value\"\s*:/i);
    if (
      afterBrowserTeach.skills.length !== 3
      || browserSkill?.version !== 1
      || browserSkill?.trustState !== "reviewed"
      || !browserSkill?.capabilityIds.includes("browser-read")
      || !browserSkill?.capabilityIds.includes("browser-act")
      || !browserSkill?.instructions.includes("[codelit-browser-recipe-v1]")
      || retainedBrowserValue
    ) {
      throw new Error(`The demonstrated browser skill was not saved without typed values: ${JSON.stringify(afterBrowserTeach)}`);
    }

    await page.getByLabel("Message Beta Beacon").fill("Run Customer lookup");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const browserSkillRun = page.getByRole("region", { name: "Run Customer lookup", exact: true });
    await browserSkillRun.waitFor({ state: "visible" });
    await browserSkillRun.getByLabel("Customer email", { exact: true }).fill("customer@example.com");
    await browserSkillRun.getByRole("button", { name: "Start", exact: true }).click();
    const exactBrowserReview = browserSkillRun.getByRole("group", { name: "Exact browser action review", exact: true });
    await exactBrowserReview.getByText("Enter Customer email", { exact: true }).waitFor({ state: "visible", timeout: 5_000 });
    await exactBrowserReview.getByText("Typed value: 20 characters; content is omitted", { exact: false }).waitFor({ state: "visible" });
    const beforeBrowserSkillAction = await fixtureSnapshot();
    const persistedBeforeBrowserAction = JSON.stringify({
      skill: beforeBrowserSkillAction.skills.find((skill) => skill.name === "Customer lookup"),
      approvals: beforeBrowserSkillAction.approvals,
      checkpoints: beforeBrowserSkillAction.checkpoints,
      receipts: beforeBrowserSkillAction.receipts,
      browserApprovals: beforeBrowserSkillAction.browserApprovals,
    });
    if (
      beforeBrowserSkillAction.browserApprovals.length !== 1
      || beforeBrowserSkillAction.browserApprovals[0].valueLength !== 20
      || persistedBeforeBrowserAction.includes("customer@example.com")
    ) {
      throw new Error(`Browser replay persisted a run-time value before approval: ${persistedBeforeBrowserAction}`);
    }
    consoleIssues.length = 0;
    await addAudit("Browser skill approval");
    const browserSkillApprovalScreenshot = compact
      ? "browser-skill-approval-compact.png"
      : "browser-skill-approval.png";
    await page.screenshot({ path: resolve(outputDirectory, browserSkillApprovalScreenshot) });
    screenshots.push(browserSkillApprovalScreenshot);

    await exactBrowserReview.getByRole("button", { name: "Allow once", exact: true }).click();
    await exactBrowserReview.getByText("Click Search", { exact: true }).waitFor({ state: "visible", timeout: 5_000 });
    await exactBrowserReview.getByRole("button", { name: "Allow once", exact: true }).click();
    await exactBrowserReview.getByText("Take over for identity or consent", { exact: true })
      .waitFor({ state: "visible", timeout: 5_000 });
    await exactBrowserReview.getByText("This step stays under your control.", { exact: true })
      .waitFor({ state: "visible" });
    consoleIssues.length = 0;
    await addAudit("Browser skill takeover");
    const browserSkillTakeoverScreenshot = compact
      ? "browser-skill-takeover-compact.png"
      : "browser-skill-takeover.png";
    await page.screenshot({ path: resolve(outputDirectory, browserSkillTakeoverScreenshot) });
    screenshots.push(browserSkillTakeoverScreenshot);
    await exactBrowserReview.getByRole("button", { name: "Take over", exact: true }).click();
    await exactBrowserReview.getByText("You have control of this protected step.", { exact: true })
      .waitFor({ state: "visible" });
    await exactBrowserReview.getByRole("button", { name: "I finished this step", exact: true }).click();
    await browserSkillRun.waitFor({ state: "detached", timeout: 5_000 });
    await page.locator(".bot-message.assistant")
      .filter({ hasText: "Customer lookup finished 3 reviewed steps." })
      .waitFor({ state: "visible", timeout: 5_000 });
    const afterBrowserSkillRun = await fixtureSnapshot();
    const usedRuntimeValue = await page.evaluate(() => (
      window.__CODELIT_PARALLEL_QA__.usedBrowserValue("customer@example.com")
    ));
    const browserReplayReceiptBody = afterBrowserSkillRun.receipts.find((receipt) => (
      receipt.body?.provider === "codelit" && receipt.body?.model === "browser-replay-v1"
    ));
    const persistedAfterBrowserAction = JSON.stringify({
      skill: afterBrowserSkillRun.skills.find((skill) => skill.name === "Customer lookup"),
      approvals: afterBrowserSkillRun.approvals,
      checkpoints: afterBrowserSkillRun.checkpoints,
      receipts: afterBrowserSkillRun.receipts,
      browserApprovals: afterBrowserSkillRun.browserApprovals,
      browserActions: afterBrowserSkillRun.browserActions,
    });
    if (
      !usedRuntimeValue
      || afterBrowserSkillRun.browserActions.length !== 2
      || afterBrowserSkillRun.browserActions[0].action !== "type"
      || afterBrowserSkillRun.browserActions[0].target !== '[aria-label="Customer email"]'
      || afterBrowserSkillRun.browserActions[0].valueLength !== 20
      || afterBrowserSkillRun.browserActions[1].action !== "click"
      || afterBrowserSkillRun.browserActions[1].target !== "text:Search"
      || browserReplayReceiptBody?.body?.details?.approval?.scope !== "browser-skill-replay"
      || browserReplayReceiptBody?.body?.details?.execution?.automatedSteps !== 2
      || browserReplayReceiptBody?.body?.details?.execution?.takeoverSteps !== 1
      || browserReplayReceiptBody?.body?.details?.execution?.completedStepIds?.length !== 3
      || browserReplayReceiptBody?.body?.meteredProviderInvocationStarted !== false
      || persistedAfterBrowserAction.includes("customer@example.com")
    ) {
      throw new Error(`Browser replay did not preserve its exact, private receipt boundary: ${persistedAfterBrowserAction}`);
    }
    consoleIssues.length = 0;
    await addAudit("Browser skill replay");
    const browserSkillReplayScreenshot = compact
      ? "browser-skill-replay-compact.png"
      : "browser-skill-replay.png";
    await page.screenshot({ path: resolve(outputDirectory, browserSkillReplayScreenshot) });
    screenshots.push(browserSkillReplayScreenshot);

    await browserSkillCard.getByRole("button", { name: "Undo", exact: true }).click();
    await browserSkillCard.waitFor({ state: "detached" });
    const afterBrowserSkillUndo = await fixtureSnapshot();
    if (afterBrowserSkillUndo.skills.length !== 2
      || afterBrowserSkillUndo.skills.some((skill) => skill.source !== "built-in")
      || afterBrowserSkillUndo.browserSessions.length !== 0) {
      throw new Error(`Browser teaching did not release its skill or private browser: ${JSON.stringify(afterBrowserSkillUndo)}`);
    }

    await page.getByLabel("Message Beta Beacon").fill("Check release health every weekday at 8 AM");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const routines = page.getByRole("region", { name: "Bot routines", exact: true });
    await routines.waitFor({ state: "visible" });
    await routines.getByText("Every weekday at 8:00 AM", { exact: true }).waitFor({ state: "visible" });
    const startRoutine = routines.getByRole("button", { name: "Start", exact: true });
    await startRoutine.click();
    await routines.getByRole("button", { name: "Pause", exact: true }).waitFor({ state: "visible" });
    const routineSnapshot = await fixtureSnapshot();
    if (
      routineSnapshot.schedules.length !== 1
      || routineSnapshot.schedules[0].enabled !== true
      || routineSnapshot.bots.find((candidate) => candidate.id === botB)?.spec.autonomyPolicy.allowBackground !== true
    ) {
      throw new Error(`The reviewed bot routine did not become active: ${JSON.stringify(routineSnapshot)}`);
    }
    await routines.getByRole("button", { name: "Pause", exact: true }).click();
    await routines.getByRole("button", { name: "Start", exact: true }).waitFor({ state: "visible" });

    await page.getByLabel("Message Beta Beacon")
      .fill("Change my routine to every Friday at 4:30 PM");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await routines.getByText("Every Friday at 4:30 PM", { exact: true }).waitFor({ state: "visible" });
    const changeUndo = page.getByRole("region", { name: "Recent bot or routine change", exact: true });
    await changeUndo.getByText("Routine rescheduled", { exact: true }).waitFor({ state: "visible" });
    const changedRoutineSnapshot = await fixtureSnapshot();
    if (
      changedRoutineSnapshot.schedules[0].cadence !== "weekly"
      || changedRoutineSnapshot.schedules[0].localTime !== "16:30"
      || JSON.stringify(changedRoutineSnapshot.schedules[0].weekdays) !== JSON.stringify([5])
    ) {
      throw new Error(`The chat change did not persist the reviewed cadence: ${JSON.stringify(changedRoutineSnapshot.schedules)}`);
    }
    consoleIssues.length = 0;
    await addAudit("Chat change undo");
    const changeScreenshot = compact ? "chat-change-undo-compact.png" : "chat-change-undo.png";
    await page.screenshot({ path: resolve(outputDirectory, changeScreenshot) });
    screenshots.push(changeScreenshot);
    await changeUndo.getByRole("button", { name: "Undo", exact: true }).click();
    await changeUndo.waitFor({ state: "detached" });
    await routines.getByText("Every weekday at 8:00 AM", { exact: true }).waitFor({ state: "visible" });
    const restoredRoutineSnapshot = await fixtureSnapshot();
    if (
      restoredRoutineSnapshot.schedules[0].cadence !== "weekdays"
      || restoredRoutineSnapshot.schedules[0].localTime !== "08:00"
      || JSON.stringify(restoredRoutineSnapshot.schedules[0].weekdays) !== JSON.stringify([1, 2, 3, 4, 5])
    ) {
      throw new Error(`Undo did not restore the exact prior cadence: ${JSON.stringify(restoredRoutineSnapshot.schedules)}`);
    }

    await page.getByLabel("Message Beta Beacon")
      .fill("When this project changes, summarize what changed");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const eventRoutine = routines.locator(".bot-routine-card")
      .filter({ hasText: "When this project changes" });
    await eventRoutine.waitFor({ state: "visible" });
    await eventRoutine.getByRole("button", { name: "Start", exact: true }).click();
    await eventRoutine.getByRole("button", { name: "Pause", exact: true }).waitFor({ state: "visible" });
    await eventRoutine.getByText("Watching 148 project files", { exact: true }).waitFor({ state: "visible" });
    const eventRoutineSnapshot = await fixtureSnapshot();
    if (
      eventRoutineSnapshot.eventRoutines.length !== 1
      || eventRoutineSnapshot.eventRoutines[0].enabled !== true
      || eventRoutineSnapshot.eventRoutines[0].lastFileCount !== 148
      || eventRoutineSnapshot.bots.find((candidate) => candidate.id === botB)?.spec.autonomyPolicy.allowBackground !== true
    ) {
      throw new Error(`The project-change routine did not capture its baseline: ${JSON.stringify(eventRoutineSnapshot)}`);
    }
    await addAudit("Bot routine");
    const routineScreenshot = compact ? "bot-routine-compact.png" : "bot-routine.png";
    await page.screenshot({ path: resolve(outputDirectory, routineScreenshot) });
    screenshots.push(routineScreenshot);
    await eventRoutine.getByRole("button", { name: "Pause", exact: true }).click();
    await eventRoutine.getByRole("button", { name: "Start", exact: true }).waitFor({ state: "visible" });

    const providerRunCountBeforeData = (await fixtureSnapshot()).providerRuns.length;
    await page.getByLabel("Message Beta Beacon")
      .fill("Create a table called Page observations with columns URL:url, Changed:boolean, Summary, Score:number");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const localTable = page.getByRole("region", { name: "Page observations", exact: true });
    await localTable.waitFor({ state: "visible" });
    await localTable.getByText("This table is ready for its first row.", { exact: true }).waitFor({ state: "visible" });
    await page.getByLabel("Message Beta Beacon")
      .fill('Add to Page observations: URL="https://codelit.io/pricing", Changed=true, Summary="Pricing changed", Score=9.5');
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await localTable.getByRole("cell", { name: "https://codelit.io/pricing", exact: true }).waitFor({ state: "visible" });
    await localTable.getByRole("cell", { name: "9.5", exact: true }).waitFor({ state: "visible" });
    const dataSnapshot = await fixtureSnapshot();
    const savedTable = dataSnapshot.botTables[0];
    const savedRows = savedTable ? dataSnapshot.botTableRows[savedTable.id] : [];
    if (
      dataSnapshot.providerRuns.length !== providerRunCountBeforeData
      || dataSnapshot.botTables.length !== 1
      || savedTable?.botId !== botB
      || savedRows?.length !== 1
      || savedRows[0]?.values?.Changed !== true
      || savedRows[0]?.values?.Score !== 9.5
    ) {
      throw new Error(`The chat-native local table crossed a bot or provider boundary: ${JSON.stringify(dataSnapshot)}`);
    }
    await localTable.getByLabel("Filter Page observations", { exact: true }).fill("pricing");
    if (compact) {
      await localTable.evaluate((element) => {
        const scroller = element.closest(".bots-thread-scroll");
        const topbar = document.querySelector(".bots-topbar");
        if (!(scroller instanceof HTMLElement) || !(topbar instanceof HTMLElement)) return;
        scroller.scrollTop += element.getBoundingClientRect().top - topbar.getBoundingClientRect().bottom - 12;
      });
      await page.waitForFunction(() => {
        const table = document.querySelector(".bot-data-artifact");
        const topbar = document.querySelector(".bots-topbar");
        if (!(table instanceof HTMLElement) || !(topbar instanceof HTMLElement)) return false;
        const top = table.getBoundingClientRect().top;
        return top >= topbar.getBoundingClientRect().bottom + 10 && top < window.innerHeight / 2;
      });
    }
    consoleIssues.length = 0;
    await addAudit("Local bot table");
    const dataScreenshot = compact ? "local-bot-table-compact.png" : "local-bot-table.png";
    await page.screenshot({ path: resolve(outputDirectory, dataScreenshot) });
    screenshots.push(dataScreenshot);
    await localTable.getByRole("button", { name: "Export Page observations as CSV", exact: true }).click();
    await page.getByText("Page observations exported as CSV", { exact: true }).waitFor({ state: "visible" });
    const exportSnapshot = await fixtureSnapshot();
    if (exportSnapshot.exportedBotTables.length !== 1
      || exportSnapshot.exportedBotTables[0].botId !== botB) {
      throw new Error(`The local table export lost its bot scope: ${JSON.stringify(exportSnapshot.exportedBotTables)}`);
    }
    await localTable.getByRole("button", { name: "Close Page observations", exact: true }).click();
    await localTable.waitFor({ state: "detached" });

    await page.getByLabel("Message Beta Beacon").fill("Show the secure rollout as structured Markdown.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const runB = await waitForProviderRun(botB);
    consoleIssues.length = 0;
    await page.evaluate(({ runId, answer }) => {
      window.__CODELIT_PARALLEL_QA__.emit(runId, "reasoning-delta", "Formatting a grounded technical answer. ");
      window.__CODELIT_PARALLEL_QA__.complete(runId, answer);
    }, { runId: runB, answer: markdownAnswer });

    const markdown = page.locator(".bot-message.assistant .bot-markdown").last();
    await markdown.getByRole("heading", { name: "Secure rollout", level: 2 })
      .waitFor({ state: "visible", timeout: 8_000 });
    if (await markdown.locator("ul > li").count() !== 2) {
      throw new Error("The technical answer did not render its Markdown list semantically.");
    }
    await markdown.getByRole("table").waitFor({ state: "visible" });
    await markdown.getByRole("columnheader", { name: "Layer", exact: true }).waitFor({ state: "visible" });
    await markdown.getByRole("cell", { name: "Least privilege", exact: true }).waitFor({ state: "visible" });
    const code = markdown.locator("pre code");
    await code.waitFor({ state: "visible" });
    if (!(await code.textContent())?.includes("BEGIN READ ONLY;")) {
      throw new Error("The technical answer did not render its fenced code block semantically.");
    }
    const markdownLayout = await markdown.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const message = element.closest(".bot-message")?.getBoundingClientRect();
      const root = document.documentElement;
      return {
        left: bounds.left,
        right: bounds.right,
        messageLeft: message?.left || 0,
        messageRight: message?.right || 0,
        viewportWidth: window.innerWidth,
        outerOverflow: root.scrollWidth - root.clientWidth,
        text: element.textContent || "",
      };
    });
    if (
      markdownLayout.left < markdownLayout.messageLeft - 1
      || markdownLayout.right > markdownLayout.messageRight + 1
      || markdownLayout.right > markdownLayout.viewportWidth + 1
      || markdownLayout.outerOverflow > 1
      || markdownLayout.text.includes("| Layer |")
      || markdownLayout.text.includes("```")
    ) {
      throw new Error(`The semantic Markdown answer overflowed or exposed source syntax: ${JSON.stringify(markdownLayout)}`);
    }
    if (compact) {
      await markdown.evaluate((element) => {
        const scroller = element.closest(".bots-thread-scroll");
        const topbar = document.querySelector(".bots-topbar");
        if (!(scroller instanceof HTMLElement) || !(topbar instanceof HTMLElement)) return;
        const top = topbar.getBoundingClientRect().bottom + 14;
        scroller.scrollTop += element.getBoundingClientRect().top - top;
      });
      await page.waitForFunction(() => {
        const heading = document.querySelector(".bot-message.assistant .bot-markdown h2");
        const topbar = document.querySelector(".bots-topbar");
        if (!(heading instanceof HTMLElement) || !(topbar instanceof HTMLElement)) return false;
        const top = heading.getBoundingClientRect().top;
        return top >= topbar.getBoundingClientRect().bottom + 10 && top < window.innerHeight / 2;
      });
    }
    await addAudit("Markdown response");
    const markdownScreenshot = compact ? "markdown-response-compact.png" : "markdown-response.png";
    await page.screenshot({ path: resolve(outputDirectory, markdownScreenshot) });
    screenshots.push(markdownScreenshot);
  } finally {
    await context.close();
  }
}

async function auditComputerAction(browser, url, matrix, records, failures, screenshots) {
  const compact = matrix.id === "minimum-light";
  const context = await browser.newContext({
    viewport: { width: matrix.width, height: matrix.height },
    colorScheme: matrix.colorScheme,
    locale: matrix.locale,
    reducedMotion: "reduce",
  });
  await context.addInitScript(installParallelBotTauriFixture, builtinSkillManifests);
  const page = await context.newPage();
  const consoleIssues = [];
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type())) consoleIssues.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));
  const addAudit = async (label) => {
    await page.addScriptTag({ content: axe.source });
    const record = await auditCurrentSurface(page, matrix, label, consoleIssues);
    records.push(record);
    failures.push(...record.issues.map((issue) => `${matrix.id}/${label}: ${issue}`));
  };
  const snapshot = () => page.evaluate(() => window.__CODELIT_PARALLEL_QA__.snapshot());

  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.getByLabel("Message Alpha").waitFor({ state: "visible", timeout: 4_000 });
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("button", { name: "Privacy", exact: true }).click();
    const computer = settings.getByRole("region", { name: "Computer use", exact: true });
    await computer.getByText("Ready on this Mac", { exact: true }).waitFor({ state: "visible" });
    await computer.getByRole("button", { name: "Allow", exact: true }).click();
    await computer.getByText("Safari", { exact: true }).waitFor({ state: "visible" });
    await settings.getByRole("button", { name: "Close settings", exact: true }).click();
    await settings.waitFor({ state: "detached" });

    await page.getByLabel("Message Alpha").fill("Use Safari to press New Tab");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForFunction(() => window.__CODELIT_PARALLEL_QA__.snapshot().providerRuns.some((run) => (
      run.owner?.botId === "bot-alpha" && run.settled === null
    )), null, { timeout: 5_000 });
    const planning = await snapshot();
    const runId = planning.providerRuns.find((run) => (
      run.owner?.botId === "bot-alpha" && run.settled === null
    ))?.runId;
    if (!runId) throw new Error("Computer QA did not create a planner run.");
    await page.evaluate((id) => {
      window.__CODELIT_PARALLEL_QA__.completeWithItems(
        id,
        "I can open one new tab after approval.",
        ['ACTION {"kind":"press","target":"New Tab","role":"AXButton","occurrence":0}'],
      );
    }, runId);

    const approval = page.getByRole("region", { name: "Use Safari?", exact: true });
    await approval.waitFor({ state: "visible", timeout: 5_000 });
    await approval.getByText('Press "New Tab"', { exact: true }).waitFor({ state: "visible" });
    consoleIssues.length = 0;
    await addAudit("Computer approval");
    const approvalScreenshot = compact ? "computer-approval-compact.png" : "computer-approval.png";
    await page.screenshot({ path: resolve(outputDirectory, approvalScreenshot) });
    screenshots.push(approvalScreenshot);

    await approval.getByRole("button", { name: "Allow once", exact: true }).click();
    const evidence = page.getByRole("region", { name: "Computer action evidence", exact: true });
    await evidence.waitFor({ state: "visible", timeout: 5_000 });
    await evidence.getByText("Pressed New Tab in Safari.", { exact: true }).waitFor({ state: "visible" });
    if (await evidence.locator("img").count() !== 2) {
      throw new Error("Computer QA did not render before and after evidence.");
    }
    const completed = await snapshot();
    const action = completed.computerActions.at(-1);
    const approvalDecision = completed.approvalDecisions.at(-1);
    const receipt = completed.receipts.find((candidate) => candidate.runId === runId);
    if (action?.action?.target !== "New Tab"
      || approvalDecision?.status !== "approved"
      || receipt?.body?.details?.computer?.action?.target !== "New Tab"
      || Object.hasOwn(receipt?.body?.details?.computer?.action || {}, "value")
      || receipt?.body?.details?.computer?.evidence?.length !== 2
      || receipt?.body?.details?.computer?.evidence?.some((frame) => frame.windowId !== 42)
      || receipt?.body?.details?.computer?.environment?.continuity !== "continuous"
      || receipt?.body?.details?.computer?.environment?.before?.activeDisplayCount !== 2
      || receipt?.body?.details?.computer?.environment?.after?.topologySha256 !== "d".repeat(64)) {
      throw new Error(`Computer action did not remain scoped and redacted in its receipt: ${JSON.stringify({ action, approvalDecision, receipt })}`);
    }
    consoleIssues.length = 0;
    await addAudit("Computer action");
    const actionScreenshot = compact ? "computer-action-compact.png" : "computer-action.png";
    await page.screenshot({ path: resolve(outputDirectory, actionScreenshot) });
    screenshots.push(actionScreenshot);
  } finally {
    await context.close();
  }
}

async function runRendererQa() {
  mkdirSync(outputDirectory, { recursive: true });
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}/`;
  const preview = spawn("npm", [
    "--prefix", appRoot, "run", "preview", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort",
  ], { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
  let previewLog = "";
  preview.stdout.on("data", (chunk) => { previewLog += chunk; });
  preview.stderr.on("data", (chunk) => { previewLog += chunk; });
  const records = [];
  const failures = [];
  const screenshots = [];
  let browser;
  try {
    await waitForServer(url, preview);
    browser = await chromium.launch({ headless: true });
    for (const matrix of matrices) {
      const context = await browser.newContext({
        viewport: { width: matrix.width, height: matrix.height },
        colorScheme: matrix.colorScheme,
        locale: matrix.locale,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const consoleIssues = [];
      page.on("console", (message) => {
        if (["warning", "error"].includes(message.type())) consoleIssues.push(`${message.type()}: ${message.text()}`);
      });
      page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));
      const started = Date.now();
      await page.goto(url, { waitUntil: "networkidle" });
      await page.locator(surfaces[0].ready).waitFor({ state: "visible", timeout: 4_000 });
      await page.locator(".bots-loading").waitFor({ state: "detached", timeout: 4_000 }).catch(() => undefined);
      const readyMs = Date.now() - started;
      if (readyMs > 5_000) failures.push(`${matrix.id}/Bots: first meaningful screen took ${readyMs}ms`);
      await page.addScriptTag({ content: axe.source });
      consoleIssues.length = 0;
      const surface = surfaces[0];
      const record = await auditCurrentSurface(page, matrix, surface.label, consoleIssues);
      records.push({ ...record, readyMs });
      failures.push(...record.issues.map((issue) => `${matrix.id}/${surface.label}: ${issue}`));
      if (matrix.width === 1440 && matrix.height === 900 && matrix.colorScheme === "light") {
        await page.screenshot({ path: resolve(outputDirectory, "bots.png") });
        screenshots.push("bots.png");
      }
      if (matrix.id === "minimum-light") {
        await page.screenshot({ path: resolve(outputDirectory, "bots-compact.png") });
        screenshots.push("bots-compact.png");
      }
      if (matrix.exercise) await exerciseSurface(page, surface.label);
      await auditPanels(page, matrix, records, failures, consoleIssues, screenshots);
      await auditBrowserApproval(page, matrix, records, failures, consoleIssues, screenshots);
      await auditRunReceipt(page, matrix, records, failures, consoleIssues, screenshots);
      await context.close();
    }
    await auditGroundedLocalCapabilities(browser, url, records, failures, screenshots);
    await auditParallelBots(browser, url, records, failures, screenshots);
    await auditPersistentBrowserDomains(browser, url, records, failures, screenshots);
    await auditCompactBotHandoff(browser, url, records, failures, screenshots);
    for (const matrixId of ["release-light", "minimum-dark"]) {
      const matrix = matrices.find((candidate) => candidate.id === matrixId);
      if (!matrix) throw new Error(`The ${matrixId} renderer matrix is unavailable.`);
      await auditPrivateProductReport(browser, url, matrix, records, failures, screenshots);
    }
    for (const matrixId of ["release-light", "minimum-light"]) {
      const matrix = matrices.find((candidate) => candidate.id === matrixId);
      if (!matrix) throw new Error(`The ${matrixId} renderer matrix is unavailable.`);
      await auditTypedBrowserAction(browser, url, matrix, records, failures, screenshots);
      await auditQuarantinedBrowserDownload(browser, url, matrix, records, failures, screenshots);
      await auditBotProfileAndMarkdown(browser, url, matrix, records, failures, screenshots);
      await auditComputerAction(browser, url, matrix, records, failures, screenshots);
      await auditMcpChatAction(browser, url, matrix, records, failures, screenshots);
    }
  } finally {
    await browser?.close();
    await stopServer(preview);
  }

  const packageVersion = JSON.parse(readFileSync(resolve(appRoot, "package.json"), "utf8")).version;
  const receipt = {
    schemaVersion: 1,
    status: failures.length ? "failed" : "passed",
    createdAt: new Date().toISOString(),
    source: {
      commit: commandOutput("git", ["rev-parse", "HEAD"]),
      dirty: Boolean(commandOutput("git", ["status", "--porcelain"])),
      version: packageVersion,
    },
    environment: {
      platform: `${process.platform}-${process.arch}`,
      osVersion: commandOutput("sw_vers", ["-productVersion"]),
      chip: commandOutput("sysctl", ["-n", "machdep.cpu.brand_string"]),
      memoryBytes: Number(commandOutput("sysctl", ["-n", "hw.memsize"])) || null,
      driver: "Playwright renderer fallback",
    },
    matrices,
    records,
    screenshots,
    failures,
  };
  const receiptPath = resolve(outputDirectory, "renderer-qa.json");
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  if (failures.length) {
    process.stderr.write(`${JSON.stringify({ receiptPath, failures, previewLog }, null, 2)}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify({ receiptPath, status: "passed", records: records.length, screenshots }, null, 2)}\n`);
  }
}

await runRendererQa();
