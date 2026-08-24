import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const appDirectory = resolve(scriptsDirectory, "..");
const source = resolve(appDirectory, "native/scheduler-helper/SchedulerHelper.swift");
const targetTriple = process.arch === "arm64"
  ? "aarch64-apple-darwin"
  : process.arch === "x64"
    ? "x86_64-apple-darwin"
    : null;

if (!targetTriple) {
  throw new Error(`Unsupported macOS architecture: ${process.arch}`);
}

const output = resolve(
  appDirectory,
  `src-tauri/binaries/codelit-scheduler-helper-${targetTriple}`,
);
mkdirSync(dirname(output), { recursive: true });

const target = process.arch === "arm64"
  ? "arm64-apple-macos13.0"
  : "x86_64-apple-macos13.0";
const build = spawnSync(
  "xcrun",
  ["--sdk", "macosx", "swiftc", "-O", "-target", target, source, "-o", output],
  { stdio: "inherit" },
);
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}
chmodSync(output, 0o755);

const probe = spawnSync(output, ["--self-test"], { encoding: "utf8" });
if (probe.status !== 0) {
  process.stderr.write(probe.stderr);
  process.exit(probe.status ?? 1);
}
const result = JSON.parse(probe.stdout);
if (result.status !== "idle" || result.engine !== "smappservice-launch-agent") {
  throw new Error("Scheduler helper returned an invalid self-test payload.");
}

const fixtureDirectory = mkdtempSync(resolve(tmpdir(), "codelit-scheduler-helper-"));
try {
  const database = resolve(fixtureDirectory, "scheduler.sqlite3");
  const schema = `
    CREATE TABLE local_schedules (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      next_due_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE schedule_occurrences (
      idempotency_key TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      schedule_revision INTEGER NOT NULL,
      scheduled_for TEXT NOT NULL,
      status TEXT NOT NULL,
      claim_owner TEXT,
      claim_token TEXT,
      lease_expires_at TEXT,
      attempt INTEGER NOT NULL,
      next_attempt_at TEXT,
      run_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE routines (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      trigger_kind TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE event_routine_state (
      routine_id TEXT PRIMARY KEY,
      last_checked_at TEXT
    );
    CREATE TABLE bot_autonomy_policy (
      id INTEGER PRIMARY KEY,
      globally_paused INTEGER NOT NULL,
      quiet_hours_enabled INTEGER NOT NULL,
      quiet_start TEXT NOT NULL,
      quiet_end TEXT NOT NULL,
      daily_digest_enabled INTEGER NOT NULL,
      daily_digest_time TEXT NOT NULL,
      last_digest_local_date TEXT,
      timezone TEXT NOT NULL
    );
    INSERT INTO bot_autonomy_policy (
      id, globally_paused, quiet_hours_enabled, quiet_start, quiet_end,
      daily_digest_enabled, daily_digest_time, last_digest_local_date, timezone
    ) VALUES (1, 0, 0, '22:00', '07:00', 0, '17:00', NULL, 'UTC');
    INSERT INTO local_schedules (id, enabled, revision, next_due_at, deleted_at)
    VALUES ('schedule-helper-test', 1, 3, '2026-08-11T15:00:00.000Z', NULL);
  `;
  const initialized = spawnSync("/usr/bin/sqlite3", [database, schema], { encoding: "utf8" });
  if (initialized.status !== 0) {
    throw new Error(`Could not create the scheduler helper fixture: ${initialized.stderr}`);
  }

  const claim = spawnSync(
    output,
    ["--claim-only", database, "2026-08-11T15:01:00.000Z"],
    { encoding: "utf8" },
  );
  const claimed = JSON.parse(claim.stdout);
  if (claim.status !== 0 || !claimed.claimed || claimed.launched) {
    throw new Error(`Scheduler helper did not reserve the due fixture: ${claim.stderr}`);
  }

  const duplicate = spawnSync(
    output,
    ["--claim-only", database, "2026-08-11T15:01:30.000Z"],
    { encoding: "utf8" },
  );
  if (duplicate.status !== 0 || JSON.parse(duplicate.stdout).claimed) {
    throw new Error("Scheduler helper claimed the same occurrence twice before its lease expired.");
  }

  const pausedPolicy = spawnSync(
    "/usr/bin/sqlite3",
    [database, "UPDATE bot_autonomy_policy SET globally_paused = 1; UPDATE schedule_occurrences SET lease_expires_at = '2026-08-11T15:00:00.000Z';"],
    { encoding: "utf8" },
  );
  if (pausedPolicy.status !== 0) {
    throw new Error(`Could not pause the scheduler fixture: ${pausedPolicy.stderr}`);
  }
  const pausedWake = spawnSync(
    output,
    ["--claim-only", database, "2026-08-11T15:02:00.000Z"],
    { encoding: "utf8" },
  );
  if (pausedWake.status !== 0 || JSON.parse(pausedWake.stdout).claimed) {
    throw new Error("Scheduler helper woke Codelit while all routines were paused.");
  }
  const resumePolicy = spawnSync(
    "/usr/bin/sqlite3",
    [database, "UPDATE bot_autonomy_policy SET globally_paused = 0;"],
    { encoding: "utf8" },
  );
  if (resumePolicy.status !== 0) {
    throw new Error(`Could not resume the scheduler fixture: ${resumePolicy.stderr}`);
  }

  const quietPolicy = spawnSync(
    "/usr/bin/sqlite3",
    [database, "UPDATE bot_autonomy_policy SET quiet_hours_enabled = 1, quiet_start = '00:00', quiet_end = '23:59';"],
    { encoding: "utf8" },
  );
  if (quietPolicy.status !== 0) {
    throw new Error(`Could not enable quiet hours for the scheduler fixture: ${quietPolicy.stderr}`);
  }
  const quietWake = spawnSync(
    output,
    ["--claim-only", database, "2026-08-11T15:02:00.000Z"],
    { encoding: "utf8" },
  );
  if (quietWake.status !== 0 || JSON.parse(quietWake.stdout).claimed) {
    throw new Error("Scheduler helper woke Codelit during quiet hours.");
  }
  const disableQuietPolicy = spawnSync(
    "/usr/bin/sqlite3",
    [database, "UPDATE bot_autonomy_policy SET quiet_hours_enabled = 0;"],
    { encoding: "utf8" },
  );
  if (disableQuietPolicy.status !== 0) {
    throw new Error(`Could not disable quiet hours for the scheduler fixture: ${disableQuietPolicy.stderr}`);
  }

  const inspection = spawnSync(
    "/usr/bin/sqlite3",
    [database, "SELECT status || '|' || claim_owner || '|' || attempt || '|' || run_id FROM schedule_occurrences;"],
    { encoding: "utf8" },
  );
  if (
    inspection.status !== 0
    || !inspection.stdout.trim().match(/^waking\|scheduler-helper\|0\|scheduled-[0-9a-f]{32}$/)
  ) {
    throw new Error(`Scheduler helper stored an invalid wake reservation: ${inspection.stdout}`);
  }

  const disabled = spawnSync(
    "/usr/bin/sqlite3",
    [database, "UPDATE local_schedules SET enabled = 0; UPDATE schedule_occurrences SET lease_expires_at = '2026-08-11T15:00:00.000Z';"],
    { encoding: "utf8" },
  );
  if (disabled.status !== 0) {
    throw new Error(`Could not disable the scheduler fixture: ${disabled.stderr}`);
  }
  const disabledClaim = spawnSync(
    output,
    ["--claim-only", database, "2026-08-11T15:03:00.000Z"],
    { encoding: "utf8" },
  );
  if (disabledClaim.status !== 0 || JSON.parse(disabledClaim.stdout).claimed) {
    throw new Error("Scheduler helper woke a disabled schedule.");
  }

  const eventFixture = spawnSync(
    "/usr/bin/sqlite3",
    [database, `
      INSERT INTO routines (id, title, enabled, trigger_kind, created_at)
      VALUES ('event-helper-test', 'Watch project', 1, 'project-change', '2026-08-11T14:00:00.000Z');
      INSERT INTO event_routine_state (routine_id, last_checked_at)
      VALUES ('event-helper-test', '2026-08-11T15:00:00.000Z');
    `],
    { encoding: "utf8" },
  );
  if (eventFixture.status !== 0) {
    throw new Error(`Could not create the event routine fixture: ${eventFixture.stderr}`);
  }
  const staleEvent = spawnSync(
    output,
    ["--claim-only", database, "2026-08-11T15:01:00.000Z"],
    { encoding: "utf8" },
  );
  if (staleEvent.status !== 0 || !JSON.parse(staleEvent.stdout).claimed) {
    throw new Error("Scheduler helper did not wake Codelit for a stale project-change check.");
  }

  const refreshedEvent = spawnSync(
    "/usr/bin/sqlite3",
    [database, "UPDATE event_routine_state SET last_checked_at = '2026-08-11T15:01:00.000Z';"],
    { encoding: "utf8" },
  );
  if (refreshedEvent.status !== 0) {
    throw new Error(`Could not refresh the event routine fixture: ${refreshedEvent.stderr}`);
  }
  const recentEvent = spawnSync(
    output,
    ["--claim-only", database, "2026-08-11T15:01:30.000Z"],
    { encoding: "utf8" },
  );
  if (recentEvent.status !== 0 || JSON.parse(recentEvent.stdout).claimed) {
    throw new Error("Scheduler helper woke Codelit for a recently checked project routine.");
  }

  const disabledEvent = spawnSync(
    "/usr/bin/sqlite3",
    [database, "UPDATE routines SET enabled = 0 WHERE id = 'event-helper-test'; UPDATE event_routine_state SET last_checked_at = NULL;"],
    { encoding: "utf8" },
  );
  if (disabledEvent.status !== 0) {
    throw new Error(`Could not disable the event routine fixture: ${disabledEvent.stderr}`);
  }
  const disabledEventWake = spawnSync(
    output,
    ["--claim-only", database, "2026-08-11T15:03:00.000Z"],
    { encoding: "utf8" },
  );
  if (disabledEventWake.status !== 0 || JSON.parse(disabledEventWake.stdout).claimed) {
    throw new Error("Scheduler helper woke Codelit for a disabled project routine.");
  }

  const digestFixture = spawnSync(
    "/usr/bin/sqlite3",
    [database, "UPDATE bot_autonomy_policy SET daily_digest_enabled = 1, daily_digest_time = '17:00', last_digest_local_date = '2026-08-10', timezone = 'UTC';"],
    { encoding: "utf8" },
  );
  if (digestFixture.status !== 0) {
    throw new Error(`Could not enable the daily digest fixture: ${digestFixture.stderr}`);
  }
  const dueDigest = spawnSync(
    output,
    ["--claim-only", database, "2026-08-11T17:01:00.000Z"],
    { encoding: "utf8" },
  );
  if (dueDigest.status !== 0 || !JSON.parse(dueDigest.stdout).claimed) {
    throw new Error("Scheduler helper did not wake Codelit for a due daily digest.");
  }

  const deliveredDigest = spawnSync(
    "/usr/bin/sqlite3",
    [database, "UPDATE bot_autonomy_policy SET last_digest_local_date = '2026-08-11';"],
    { encoding: "utf8" },
  );
  if (deliveredDigest.status !== 0) {
    throw new Error(`Could not mark the daily digest delivered: ${deliveredDigest.stderr}`);
  }
  const duplicateDigest = spawnSync(
    output,
    ["--claim-only", database, "2026-08-11T17:02:00.000Z"],
    { encoding: "utf8" },
  );
  if (duplicateDigest.status !== 0 || JSON.parse(duplicateDigest.stdout).claimed) {
    throw new Error("Scheduler helper woke Codelit twice for the same daily digest.");
  }
} finally {
  rmSync(fixtureDirectory, { recursive: true, force: true });
}
process.stdout.write(`${probe.stdout.trim()}\n`);
