import AppKit
import CryptoKit
import Foundation
import SQLite3

private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
private let helperOwner = "scheduler-helper"

private struct SchedulerStatus: Codable {
    let status: String
    let engine: String
    let processIdentifier: Int32
    let claimed: Bool
    let launched: Bool
}

private enum SchedulerError: LocalizedError {
    case invalidArguments
    case invalidBundle
    case sqlite(String)
    case launch(String)

    var errorDescription: String? {
        switch self {
        case .invalidArguments:
            return "Unsupported scheduler helper arguments."
        case .invalidBundle:
            return "The scheduler helper is not inside a Codelit app bundle."
        case let .sqlite(message):
            return "The local schedule database could not be updated: \(message)"
        case let .launch(message):
            return "Codelit could not be opened for scheduled work: \(message)"
        }
    }
}

private final class Database {
    private var handle: OpaquePointer?

    init(path: String) throws {
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(path, &handle, flags, nil) == SQLITE_OK else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "database unavailable"
            if let handle {
                sqlite3_close(handle)
            }
            self.handle = nil
            throw SchedulerError.sqlite(message)
        }
        sqlite3_busy_timeout(handle, 5_000)
    }

    deinit {
        if let handle {
            sqlite3_close(handle)
        }
    }

    func execute(_ sql: String, bindings: [String?] = []) throws -> Int32 {
        let statement = try prepare(sql)
        defer { sqlite3_finalize(statement) }
        try bind(bindings, to: statement)
        let result = sqlite3_step(statement)
        guard result == SQLITE_DONE else {
            throw error()
        }
        return sqlite3_changes(handle)
    }

    func firstRow(_ sql: String, bindings: [String?] = []) throws -> [String?]? {
        let statement = try prepare(sql)
        defer { sqlite3_finalize(statement) }
        try bind(bindings, to: statement)
        let result = sqlite3_step(statement)
        if result == SQLITE_DONE {
            return nil
        }
        guard result == SQLITE_ROW else {
            throw error()
        }
        return (0..<sqlite3_column_count(statement)).map { index in
            guard let value = sqlite3_column_text(statement, index) else {
                return nil
            }
            return String(cString: value)
        }
    }

    private func prepare(_ sql: String) throws -> OpaquePointer {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK,
              let statement else {
            throw error()
        }
        return statement
    }

    private func bind(_ values: [String?], to statement: OpaquePointer) throws {
        for (offset, value) in values.enumerated() {
            let index = Int32(offset + 1)
            let result: Int32
            if let value {
                result = sqlite3_bind_text(statement, index, value, -1, sqliteTransient)
            } else {
                result = sqlite3_bind_null(statement, index)
            }
            guard result == SQLITE_OK else {
                throw error()
            }
        }
    }

    private func error() -> SchedulerError {
        guard let handle else {
            return .sqlite("database unavailable")
        }
        return .sqlite(String(cString: sqlite3_errmsg(handle)))
    }
}

private func canonicalTime(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
}

private func parseTime(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: value) {
        return date
    }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: value)
}

private func randomToken() -> String {
    UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
}

private func deterministicRunID(for key: String) -> String {
    let digest = SHA256.hash(data: Data(key.utf8))
    return "scheduled-" + digest.prefix(16).map { String(format: "%02x", $0) }.joined()
}

private func occurrenceKey(scheduleID: String, revision: String, dueAt: String) throws -> String {
    guard let date = parseTime(dueAt) else {
        throw SchedulerError.sqlite("a due schedule has an invalid timestamp")
    }
    let milliseconds = Int64((date.timeIntervalSince1970 * 1_000).rounded())
    return "\(scheduleID):\(revision):\(milliseconds)"
}

private func minuteOfDay(_ value: String) -> Int? {
    let parts = value.split(separator: ":", omittingEmptySubsequences: false)
    guard parts.count == 2,
          let hour = Int(parts[0]),
          let minute = Int(parts[1]),
          (0...23).contains(hour),
          (0...59).contains(minute) else {
        return nil
    }
    return hour * 60 + minute
}

private func autonomyAllowsWake(_ database: Database, now: Date) throws -> Bool {
    let hasPolicy = try database.firstRow(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'bot_autonomy_policy'"
    )?.first ?? nil
    guard hasPolicy == "1", let row = try database.firstRow(
        "SELECT globally_paused, quiet_hours_enabled, quiet_start, quiet_end FROM bot_autonomy_policy WHERE id = 1"
    ) else {
        return true
    }
    if row[0] == "1" {
        return false
    }
    guard row[1] == "1",
          let startValue = row[2],
          let endValue = row[3],
          let start = minuteOfDay(startValue),
          let end = minuteOfDay(endValue),
          start != end else {
        return true
    }
    let components = Calendar.current.dateComponents([.hour, .minute], from: now)
    let current = (components.hour ?? 0) * 60 + (components.minute ?? 0)
    let quiet = start < end
        ? current >= start && current < end
        : current >= start || current < end
    return !quiet
}

private func dailyDigestDue(_ database: Database, now: Date) throws -> Bool {
    let hasDigestColumns = try database.firstRow(
        """
        SELECT
          (SELECT COUNT(*) FROM pragma_table_info('bot_autonomy_policy')
           WHERE name = 'daily_digest_enabled')
          +
          (SELECT COUNT(*) FROM pragma_table_info('bot_autonomy_policy')
           WHERE name = 'daily_digest_time')
          +
          (SELECT COUNT(*) FROM pragma_table_info('bot_autonomy_policy')
           WHERE name = 'last_digest_local_date')
        """
    )?.first ?? nil
    guard hasDigestColumns == "3", let row = try database.firstRow(
        """
        SELECT daily_digest_enabled, daily_digest_time, last_digest_local_date, timezone
        FROM bot_autonomy_policy WHERE id = 1
        """
    ), row[0] == "1", let digestTime = row[1], let digestMinute = minuteOfDay(digestTime) else {
        return false
    }
    let timezone = row[3].flatMap(TimeZone.init(identifier:)) ?? .current
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timezone
    let components = calendar.dateComponents([.hour, .minute], from: now)
    let currentMinute = (components.hour ?? 0) * 60 + (components.minute ?? 0)
    let candidate = currentMinute >= digestMinute
        ? now
        : calendar.date(byAdding: .day, value: -1, to: now) ?? now
    let formatter = DateFormatter()
    formatter.calendar = calendar
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = timezone
    formatter.dateFormat = "yyyy-MM-dd"
    let candidateDate = formatter.string(from: candidate)
    guard let lastDate = row[2] else {
        return true
    }
    return lastDate < candidateDate
}

private func reserveWake(databasePath: String, now: Date) throws -> Bool {
    guard FileManager.default.fileExists(atPath: databasePath) else {
        return false
    }
    let database = try Database(path: databasePath)
    let nowText = canonicalTime(now)
    let leaseText = canonicalTime(now.addingTimeInterval(120))
    let token = randomToken()
    _ = try database.execute("BEGIN IMMEDIATE")
    do {
        guard try autonomyAllowsWake(database, now: now) else {
            _ = try database.execute("COMMIT")
            return false
        }
        if let row = try database.firstRow(
            """
            SELECT o.idempotency_key
            FROM schedule_occurrences o
            JOIN local_schedules s ON s.id = o.schedule_id
            WHERE s.enabled = 1 AND s.deleted_at IS NULL
              AND (
                (o.status IN ('retry', 'paused') AND o.next_attempt_at <= ?1)
                OR (o.status IN ('waking', 'claimed', 'running')
                    AND (o.lease_expires_at IS NULL OR o.lease_expires_at <= ?1))
              )
            ORDER BY o.updated_at ASC
            LIMIT 1
            """,
            bindings: [nowText]
        ), let key = row[0] {
            let changed = try database.execute(
                """
                UPDATE schedule_occurrences
                SET status = 'waking', claim_owner = ?2, claim_token = ?3,
                    lease_expires_at = ?4, updated_at = ?5
                WHERE idempotency_key = ?1
                  AND (
                    (status IN ('retry', 'paused') AND next_attempt_at <= ?5)
                    OR (status IN ('waking', 'claimed', 'running')
                        AND (lease_expires_at IS NULL OR lease_expires_at <= ?5))
                  )
                """,
                bindings: [key, helperOwner, token, leaseText, nowText]
            )
            _ = try database.execute("COMMIT")
            return changed == 1
        }

        guard let row = try database.firstRow(
            """
            SELECT id, CAST(revision AS TEXT), next_due_at
            FROM local_schedules
            WHERE enabled = 1 AND deleted_at IS NULL
              AND next_due_at IS NOT NULL AND next_due_at <= ?1
            ORDER BY next_due_at ASC, id ASC
            LIMIT 1
            """,
            bindings: [nowText]
        ), let scheduleID = row[0], let revision = row[1], let dueAt = row[2] else {
            let eventThreshold = canonicalTime(now.addingTimeInterval(-45))
            let hasEventSchema = try database.firstRow(
                """
                SELECT
                  (SELECT COUNT(*) FROM pragma_table_info('routines') WHERE name = 'trigger_kind')
                  *
                  (SELECT COUNT(*) FROM sqlite_master
                   WHERE type = 'table' AND name = 'event_routine_state')
                """
            )?.first ?? nil
            if hasEventSchema == "1", try database.firstRow(
                """
                SELECT r.id
                FROM routines r
                LEFT JOIN event_routine_state s ON s.routine_id = r.id
                WHERE r.enabled = 1 AND r.trigger_kind = 'project-change'
                  AND (s.last_checked_at IS NULL OR s.last_checked_at <= ?1)
                ORDER BY COALESCE(s.last_checked_at, r.created_at) ASC, r.id ASC
                LIMIT 1
                """,
                bindings: [eventThreshold]
            ) != nil {
                _ = try database.execute("COMMIT")
                return true
            }
            if try dailyDigestDue(database, now: now) {
                _ = try database.execute("COMMIT")
                return true
            }
            _ = try database.execute("COMMIT")
            return false
        }

        let key = try occurrenceKey(scheduleID: scheduleID, revision: revision, dueAt: dueAt)
        let inserted = try database.execute(
            """
            INSERT OR IGNORE INTO schedule_occurrences (
                idempotency_key, schedule_id, schedule_revision, scheduled_for,
                status, claim_owner, claim_token, lease_expires_at, attempt,
                run_id, created_at, updated_at
            ) VALUES (?1, ?2, CAST(?3 AS INTEGER), ?4, 'waking', ?5, ?6, ?7, 0, ?8, ?9, ?9)
            """,
            bindings: [
                key,
                scheduleID,
                revision,
                dueAt,
                helperOwner,
                token,
                leaseText,
                deterministicRunID(for: key),
                nowText,
            ]
        )
        if inserted == 1 {
            _ = try database.execute("COMMIT")
            return true
        }

        let changed = try database.execute(
            """
            UPDATE schedule_occurrences
            SET status = 'waking', claim_owner = ?2, claim_token = ?3,
                lease_expires_at = ?4, updated_at = ?5
            WHERE idempotency_key = ?1
              AND status IN ('waking', 'claimed', 'running')
              AND (lease_expires_at IS NULL OR lease_expires_at <= ?5)
            """,
            bindings: [key, helperOwner, token, leaseText, nowText]
        )
        _ = try database.execute("COMMIT")
        return changed == 1
    } catch {
        _ = try? database.execute("ROLLBACK")
        throw error
    }
}

private func launchCodelit(at appURL: URL) throws {
    guard appURL.pathExtension == "app" else {
        throw SchedulerError.invalidBundle
    }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    configuration.addsToRecentItems = false
    configuration.createsNewApplicationInstance = false
    configuration.arguments = ["--process-local-schedules"]
    let semaphore = DispatchSemaphore(value: 0)
    var launchError: Error?
    NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { _, error in
        launchError = error
        semaphore.signal()
    }
    guard semaphore.wait(timeout: .now() + 15) == .success else {
        throw SchedulerError.launch("macOS did not finish the background launch request")
    }
    if let launchError {
        throw SchedulerError.launch(launchError.localizedDescription)
    }
}

private func defaultDatabasePath() -> String {
    FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("io.codelit.desktop", isDirectory: true)
        .appendingPathComponent("codelit-local.sqlite3", isDirectory: false)
        .path
}

private func containingAppURL() throws -> URL {
    guard let executable = Bundle.main.executableURL?.standardizedFileURL else {
        throw SchedulerError.invalidBundle
    }
    let appURL = executable
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
    guard appURL.pathExtension == "app" else {
        throw SchedulerError.invalidBundle
    }
    return appURL
}

private func encode(_ status: SchedulerStatus) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return try encoder.encode(status)
}

private func printStatus(_ status: SchedulerStatus) throws {
    let data = try encode(status)
    guard let line = String(data: data, encoding: .utf8) else {
        throw SchedulerError.invalidArguments
    }
    print(line)
}

private func run(databasePath: String, appURL: URL?, now: Date) throws -> SchedulerStatus {
    let claimed = try reserveWake(databasePath: databasePath, now: now)
    if claimed, let appURL {
        try launchCodelit(at: appURL)
    }
    return SchedulerStatus(
        status: claimed ? "wake-requested" : "idle",
        engine: "smappservice-launch-agent",
        processIdentifier: ProcessInfo.processInfo.processIdentifier,
        claimed: claimed,
        launched: claimed && appURL != nil
    )
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    if arguments == ["--version"] {
        print("Codelit scheduler helper 0.3.0")
    } else if arguments == ["--self-test"] {
        try printStatus(SchedulerStatus(
            status: "idle",
            engine: "smappservice-launch-agent",
            processIdentifier: ProcessInfo.processInfo.processIdentifier,
            claimed: false,
            launched: false
        ))
    } else if arguments.count == 2, arguments[0] == "--probe" {
        let status = try run(databasePath: defaultDatabasePath(), appURL: nil, now: Date())
        try encode(status).write(to: URL(fileURLWithPath: arguments[1]), options: .atomic)
    } else if arguments.count == 3, arguments[0] == "--claim-only",
              let now = parseTime(arguments[2]) {
        try printStatus(try run(databasePath: arguments[1], appURL: nil, now: now))
    } else if arguments.isEmpty {
        try printStatus(try run(
            databasePath: defaultDatabasePath(),
            appURL: containingAppURL(),
            now: Date()
        ))
    } else {
        throw SchedulerError.invalidArguments
    }
} catch {
    fputs("Scheduler helper failed safely: \(error.localizedDescription)\n", stderr)
    exit(error is SchedulerError ? 1 : 70)
}
