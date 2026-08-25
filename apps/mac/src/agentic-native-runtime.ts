import type {
  IntelligenceSelection,
  LocalBotDelegation,
  LocalBotRecord,
  LocalBotTableView,
  LocalBotsSnapshot,
  LocalSchedule,
  BotEventRoutine,
} from "./contracts";
import {
  appendLocalBotTableRow,
  createLocalBotDelegation,
  createLocalBotTable,
  deleteLocalEventRoutine,
  deleteLocalSchedule,
  listLocalBotMemories,
  listLocalBotSkills,
  listLocalBotTables,
  saveLocalEventRoutine,
  saveLocalSchedule,
  updateLocalBotGoal,
  updateLocalBotRoutines,
} from "./runtime";
import { coerceBotTableValues, findBotTable } from "./bot-data";
import {
  botMemorySnapshotHash,
  botSkillVersions,
  createRoutineSnapshot,
  skillsForBotRequest,
} from "./bot-initiative";
import { parseBotBrowserTarget } from "./bot-policy";
import {
  nativeRoutineTriggerLabel,
  type AgenticNativeActionProposal,
} from "./agentic-native-actions";

interface NativeRuntimeInput {
  proposal: AgenticNativeActionProposal;
  runBot: LocalBotRecord;
  runSnapshot: LocalBotsSnapshot["workspace"];
  engine?: IntelligenceSelection;
  nativeTeammates: LocalBotRecord[];
  hasApprovedProject: boolean;
}

export interface NativeRuntimeResult {
  context: string[];
  completedTools: Array<{ toolId: string; toolName: string }>;
  updatedBot?: LocalBotRecord;
  goalChangedVersion?: number;
  tableView?: LocalBotTableView;
  delegation?: LocalBotDelegation;
  schedule?: LocalSchedule;
  eventRoutine?: BotEventRoutine;
}

function routineTitle(prompt: string) {
  return prompt.length > 72 ? `${prompt.slice(0, 69).trim()}...` : prompt;
}

async function resolveTable(runBot: LocalBotRecord, query: string) {
  const tables = await listLocalBotTables(runBot.id);
  const match = findBotTable(tables, query);
  if (match.ambiguous) throw new Error(`More than one local table matches ${query}. Use its exact name.`);
  if (!match.table) {
    throw new Error(tables.length
      ? `No local table matches ${query}. Inspect the local table list, then use an exact name.`
      : "This bot has no local tables yet.");
  }
  return match.table;
}

export async function executeAgenticNativeAction(input: NativeRuntimeInput): Promise<NativeRuntimeResult> {
  const { proposal, runBot, runSnapshot, engine, nativeTeammates } = input;
  if (proposal.action === "set_goal") {
    const outcome = String(proposal.arguments.outcome);
    const updated = await updateLocalBotGoal(runBot.id, {
      ...runBot.spec.goal,
      outcome,
      status: "active",
      nextAction: "Take the smallest useful read-only step with the context available now.",
      updatedAt: new Date().toISOString(),
    }, runBot.currentVersion);
    return {
      context: [`The local goal is now: ${outcome}. The change can be undone from this conversation.`],
      completedTools: [{ toolId: `goal-${updated.currentVersion}`, toolName: "Update local goal" }],
      updatedBot: updated,
      goalChangedVersion: updated.currentVersion,
    };
  }

  if (proposal.action === "create_table") {
    const tableView = await createLocalBotTable({
      id: `table-${crypto.randomUUID()}`,
      botId: runBot.id,
      name: String(proposal.arguments.name),
      columns: proposal.arguments.columns as Array<{
        name: string;
        type: "text" | "number" | "boolean" | "date" | "url";
      }>,
      createdAt: new Date().toISOString(),
    });
    return {
      context: [`Created private local table ${tableView.table.name} with columns ${tableView.table.columns.map((column) => `${column.name} (${column.type})`).join(", ")}.`],
      completedTools: [{ toolId: tableView.table.id, toolName: `Create ${tableView.table.name}` }],
      tableView,
    };
  }

  if (proposal.action === "add_table_row") {
    const table = await resolveTable(runBot, String(proposal.arguments.tableName));
    const tableView = await appendLocalBotTableRow({
      id: `row-${crypto.randomUUID()}`,
      botId: runBot.id,
      tableId: table.id,
      values: coerceBotTableValues(
        table,
        proposal.arguments.values as Record<string, string | number | boolean | null>,
      ),
      createdAt: new Date().toISOString(),
    });
    return {
      context: [`Added one row to ${table.name}. It now has ${tableView.totalRows} rows.`],
      completedTools: [{ toolId: `${table.id}-row-${tableView.totalRows}`, toolName: `Update ${table.name}` }],
      tableView,
    };
  }

  if (proposal.action === "delegate") {
    const targetNames = proposal.arguments.targetBotNames as string[];
    const targets = targetNames.map((name) => nativeTeammates.find((candidate) => candidate.name === name));
    if (targets.some((target) => !target)) {
      throw new Error("One selected teammate is no longer in this conversation.");
    }
    const sharedMemories = (await listLocalBotMemories(runBot.id))
      .filter((memory) => memory.scope === "workspace");
    const delegation = await createLocalBotDelegation({
      id: `delegation-${crypto.randomUUID()}`,
      parentBotId: runBot.id,
      targetBotIds: targets.map((target) => target!.id),
      task: String(proposal.arguments.task),
      expectedOutput: String(proposal.arguments.expectedOutput),
      maxActions: Math.min(4, runBot.spec.autonomyPolicy.maxActionsPerRun),
      deadlineAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      sharedMemorySnapshotHash: await botMemorySnapshotHash(sharedMemories),
      createdAt: new Date().toISOString(),
    });
    return {
      context: [`Delegated the bounded task to ${delegation.targets.map((target) => target.botName).join(" and ")}. Their results will return to this conversation.`],
      completedTools: [{ toolId: delegation.id, toolName: "Delegate to teammates" }],
      delegation,
    };
  }

  const prompt = String(proposal.arguments.prompt);
  if (!engine) throw new Error("Set up one local intelligence engine before creating a routine.");
  const createdAt = new Date().toISOString();
  const routineId = `routine-${crypto.randomUUID()}`;
  const title = routineTitle(prompt);
  if (proposal.action === "watch_project") {
    if (!input.hasApprovedProject) {
      throw new Error("Choose a project folder before asking this bot to watch it.");
    }
    const [currentMemories, currentSkills] = await Promise.all([
      listLocalBotMemories(runBot.id),
      listLocalBotSkills(),
    ]);
    const selectedSkills = skillsForBotRequest(currentSkills, prompt);
    const eventRoutine = await saveLocalEventRoutine({
      id: routineId,
      botId: runBot.id,
      title,
      prompt,
      trigger: {
        kind: "project-change",
        label: "When this project changes",
        debounceSeconds: 30,
        cooldownMinutes: 5,
      },
      budget: {
        maxActions: Math.max(1, Math.min(8, runBot.spec.autonomyPolicy.maxActionsPerRun)),
        maxRetries: 2,
      },
      provider: engine.provider,
      model: engine.model,
      requiresNetwork: !["mlx", "ollama", "lmstudio"].includes(engine.provider)
        || parseBotBrowserTarget(prompt).kind === "target",
      botSnapshot: runBot.spec,
      memorySnapshotHash: await botMemorySnapshotHash(currentMemories),
      skillVersions: botSkillVersions(selectedSkills),
      createdAt,
    });
    let updatedBot: LocalBotRecord;
    try {
      updatedBot = await updateLocalBotRoutines(
        runBot.id,
        [...new Set([...runBot.spec.routineIds, routineId])],
        false,
      );
    } catch (reason) {
      await deleteLocalEventRoutine(eventRoutine.id).catch(() => undefined);
      throw reason;
    }
    return {
      context: [`Prepared a disabled local project watch: ${prompt}. It must be reviewed and started once from the routine panel.`],
      completedTools: [{ toolId: eventRoutine.id, toolName: "Prepare project watch" }],
      updatedBot,
      eventRoutine,
    };
  }

  const artifact = runSnapshot.artifacts.find((candidate) => (
    candidate.artifactId === "artifact-plan-ship-local"
  ));
  if (!artifact) throw new Error("The local routine boundary is unavailable. Reopen Codelit and try again.");
  const cadence = proposal.arguments.cadence as "daily" | "weekdays" | "weekly";
  const localTime = String(proposal.arguments.localTime);
  const weekdays = proposal.arguments.weekdays as number[];
  const triggerLabel = nativeRoutineTriggerLabel({ cadence, localTime, weekdays });
  const schedule = await saveLocalSchedule({
    id: routineId,
    threadId: runBot.threadId,
    artifactId: artifact.artifactId,
    artifactVersion: artifact.version,
    title,
    enabled: false,
    cadence,
    localTime,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    weekdays,
    missedPolicy: "run-once",
    maxRetries: 2,
    provider: engine.provider,
    model: engine.model,
    requiresNetwork: !["mlx", "ollama", "lmstudio"].includes(engine.provider)
      || parseBotBrowserTarget(prompt).kind === "target",
    snapshot: createRoutineSnapshot(runBot, routineId, prompt, triggerLabel, createdAt),
  });
  let updatedBot: LocalBotRecord;
  try {
    updatedBot = await updateLocalBotRoutines(
      runBot.id,
      [...new Set([...runBot.spec.routineIds, routineId])],
      false,
    );
  } catch (reason) {
    await deleteLocalSchedule(schedule.id).catch(() => undefined);
    throw reason;
  }
  return {
    context: [`Prepared disabled local routine ${triggerLabel}: ${prompt}. It must be reviewed and started once from the routine panel.`],
    completedTools: [{ toolId: schedule.id, toolName: "Prepare local routine" }],
    updatedBot,
    schedule,
  };
}
