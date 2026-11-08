import Foundation
import SQLite3

final class Store {
    static let shared = Store()

    private var db: OpaquePointer?
    private let queue = DispatchQueue(label: "com.kealjones.apotheosis.store", qos: .utility)

    private init() {
        openDatabase()
        createSchema()
    }

    // MARK: - Setup

    /// Data directory. Honors `DATA_DIR` the same way `packages/core/src/db.ts` does, so
    /// tests and smoke runs can point at a temp dir instead of the real database.
    static let dataDirectory: URL = {
        if let override = ProcessInfo.processInfo.environment["DATA_DIR"], !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        return FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first!
            .appendingPathComponent("apotheosis", isDirectory: true)
    }()

    private func openDatabase() {
        let appSupport = Store.dataDirectory

        try? FileManager.default.createDirectory(at: appSupport, withIntermediateDirectories: true)

        let dbPath = appSupport.appendingPathComponent("apotheosis.db").path
        if sqlite3_open(dbPath, &db) != SQLITE_OK {
            print("[Store] Failed to open database at \(dbPath): \(String(cString: sqlite3_errmsg(db)))")
        }
    }

    private func createSchema() {
        let ddl = """
        CREATE TABLE IF NOT EXISTS samples (
          id INTEGER PRIMARY KEY,
          taken_at INTEGER NOT NULL,
          app_bundle TEXT,
          app_name TEXT,
          window_title TEXT,
          url TEXT,
          screenshot_path TEXT NOT NULL,
          ocr_text TEXT,
          active_seconds INTEGER,
          is_evidence INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_samples_taken_at ON samples(taken_at);
        CREATE INDEX IF NOT EXISTS idx_samples_app ON samples(app_bundle);
        """
        var errMsg: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, ddl, nil, nil, &errMsg) != SQLITE_OK {
            let msg = errMsg.map { String(cString: $0) } ?? "unknown"
            print("[Store] Schema creation failed: \(msg)")
            sqlite3_free(errMsg)
        }

        // Migration: add vision_summary column for existing databases
        sqlite3_exec(db, "ALTER TABLE samples ADD COLUMN vision_summary TEXT;", nil, nil, nil)

        // Migration: add accessibility context columns
        sqlite3_exec(db, "ALTER TABLE samples ADD COLUMN document_path TEXT;", nil, nil, nil)
        sqlite3_exec(db, "ALTER TABLE samples ADD COLUMN selected_text TEXT;", nil, nil, nil)
        sqlite3_exec(db, "ALTER TABLE samples ADD COLUMN focused_element TEXT;", nil, nil, nil)
        sqlite3_exec(db, "ALTER TABLE samples ADD COLUMN visible_windows TEXT;", nil, nil, nil)

        // Structured Slack messages extracted via the accessibility tree (SlackExtractor)
        let slackDDL = """
        CREATE TABLE IF NOT EXISTS slack_messages (
          id INTEGER PRIMARY KEY,
          captured_at INTEGER NOT NULL,
          channel TEXT,
          sender TEXT NOT NULL,
          text TEXT NOT NULL,
          date_bucket TEXT,
          time_label TEXT,
          permalink TEXT,
          dedupe_hash TEXT UNIQUE NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_slack_messages_captured_at ON slack_messages(captured_at);
        CREATE INDEX IF NOT EXISTS idx_slack_messages_channel ON slack_messages(channel);
        """
        var slackErr: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, slackDDL, nil, nil, &slackErr) != SQLITE_OK {
            let msg = slackErr.map { String(cString: $0) } ?? "unknown"
            print("[Store] slack_messages table creation failed: \(msg)")
            sqlite3_free(slackErr)
        }

        // Migrations: add columns introduced after the table first shipped
        sqlite3_exec(db, "ALTER TABLE slack_messages ADD COLUMN time_label TEXT;", nil, nil, nil)
        sqlite3_exec(db, "ALTER TABLE slack_messages ADD COLUMN permalink TEXT;", nil, nil, nil)

        // Context events table for event-driven capture (app switches, AX events, file modifications)
        let eventsDDL = """
        CREATE TABLE IF NOT EXISTS context_events (
          id INTEGER PRIMARY KEY,
          taken_at INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          app_bundle TEXT,
          app_name TEXT,
          window_title TEXT,
          url TEXT,
          document_path TEXT,
          previous_app_bundle TEXT,
          detail TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_context_events_taken_at ON context_events(taken_at);
        CREATE INDEX IF NOT EXISTS idx_context_events_type ON context_events(event_type);
        """
        var eventsErr: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, eventsDDL, nil, nil, &eventsErr) != SQLITE_OK {
            let msg = eventsErr.map { String(cString: $0) } ?? "unknown"
            print("[Store] context_events table creation failed: \(msg)")
            sqlite3_free(eventsErr)
        }

        // Migration: Slack reactions and thread reply counts (added after the table shipped)
        sqlite3_exec(db, "ALTER TABLE slack_messages ADD COLUMN reactions TEXT;", nil, nil, nil)
        sqlite3_exec(db, "ALTER TABLE slack_messages ADD COLUMN reply_count INTEGER;", nil, nil, nil)
        // Migration: 1 when the sender came from the message's own sender button, 0 when it was
        // carried from the message above or unknown. NULL for rows captured before this column.
        sqlite3_exec(db, "ALTER TABLE slack_messages ADD COLUMN sender_explicit INTEGER;", nil, nil, nil)

        // Migration: track how many times a file_modified row was collapsed for the same day
        sqlite3_exec(db, "ALTER TABLE context_events ADD COLUMN change_count INTEGER DEFAULT 1;", nil, nil, nil)
        sqlite3_exec(db, "CREATE INDEX IF NOT EXISTS idx_context_events_document_path ON context_events(document_path);", nil, nil, nil)
        sqlite3_exec(db, "CREATE INDEX IF NOT EXISTS idx_context_events_path_taken_at ON context_events(document_path, taken_at);", nil, nil, nil)

        // Meeting detection (MeetingDetector) and transcript segments (MeetingRecorder).
        // summary/participants/action_items are filled in by later tasks.
        let meetingsDDL = """
        CREATE TABLE IF NOT EXISTS meetings (
          id INTEGER PRIMARY KEY,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          platform TEXT,
          external_id TEXT,
          title TEXT,
          url TEXT,
          calendar_event_id TEXT,
          audio_path TEXT,
          transcript_status TEXT NOT NULL DEFAULT 'pending',
          summary TEXT,
          summary_model TEXT,
          summary_generated_at INTEGER,
          action_items TEXT,
          participants TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_meetings_started_at ON meetings(started_at);

        CREATE TABLE IF NOT EXISTS meeting_segments (
          id INTEGER PRIMARY KEY,
          meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
          started_ms INTEGER NOT NULL,
          ended_ms INTEGER NOT NULL,
          channel TEXT NOT NULL,
          speaker TEXT,
          text TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_meeting_segments_meeting ON meeting_segments(meeting_id, started_ms);
        """
        var meetingsErr: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, meetingsDDL, nil, nil, &meetingsErr) != SQLITE_OK {
            let msg = meetingsErr.map { String(cString: $0) } ?? "unknown"
            print("[Store] meetings table creation failed: \(msg)")
            sqlite3_free(meetingsErr)
        }
    }

    // MARK: - Public API

    /// Inserts a new sample row and returns the row id.
    func insertSample(
        takenAt: Int64,
        appBundle: String?,
        appName: String?,
        windowTitle: String?,
        url: String?,
        screenshotPath: String,
        documentPath: String? = nil,
        selectedText: String? = nil,
        focusedElement: String? = nil,
        visibleWindows: String? = nil
    ) -> Int64 {
        var rowId: Int64 = -1
        queue.sync {
            let sql = """
            INSERT INTO samples (taken_at, app_bundle, app_name, window_title, url, screenshot_path,
                                 document_path, selected_text, focused_element, visible_windows)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
            """
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
                print("[Store] Prepare failed: \(String(cString: sqlite3_errmsg(db)))")
                return
            }
            defer { sqlite3_finalize(stmt) }

            sqlite3_bind_int64(stmt, 1, takenAt)
            bindText(stmt, 2, appBundle)
            bindText(stmt, 3, appName)
            bindText(stmt, 4, Redactor.field(windowTitle))
            bindText(stmt, 5, Redactor.field(url))
            sqlite3_bind_text(stmt, 6, (screenshotPath as NSString).utf8String, -1, nil)
            bindText(stmt, 7, documentPath)
            bindText(stmt, 8, Redactor.freeText(selectedText))
            bindText(stmt, 9, Redactor.field(focusedElement))
            bindText(stmt, 10, Redactor.field(visibleWindows))

            if sqlite3_step(stmt) == SQLITE_DONE {
                rowId = sqlite3_last_insert_rowid(db)
            } else {
                print("[Store] Insert failed: \(String(cString: sqlite3_errmsg(db)))")
            }
        }
        return rowId
    }

    /// Updates the OCR text for a previously inserted sample.
    func updateOCR(id: Int64, text: String) {
        queue.async {
            let sql = "UPDATE samples SET ocr_text = ? WHERE id = ?;"
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(self.db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
            defer { sqlite3_finalize(stmt) }

            sqlite3_bind_text(stmt, 1, (Redactor.freeText(text) as NSString).utf8String, -1, nil)
            sqlite3_bind_int64(stmt, 2, id)
            sqlite3_step(stmt)
        }
    }

    /// Inserts a context event (app switch, window focus, title change, file modification) and returns the row id.
    func insertEvent(
        takenAt: Int64,
        eventType: String,
        appBundle: String?,
        appName: String?,
        windowTitle: String?,
        url: String?,
        documentPath: String?,
        previousAppBundle: String?,
        detail: String?
    ) -> Int64 {
        var rowId: Int64 = -1
        queue.sync {
            let sql = """
            INSERT INTO context_events (taken_at, event_type, app_bundle, app_name, window_title,
                                        url, document_path, previous_app_bundle, detail)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
            """
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
                print("[Store] Prepare failed (insertEvent): \(String(cString: sqlite3_errmsg(db)))")
                return
            }
            defer { sqlite3_finalize(stmt) }

            sqlite3_bind_int64(stmt, 1, takenAt)
            sqlite3_bind_text(stmt, 2, (eventType as NSString).utf8String, -1, nil)
            bindText(stmt, 3, appBundle)
            bindText(stmt, 4, appName)
            bindText(stmt, 5, Redactor.field(windowTitle))
            bindText(stmt, 6, Redactor.field(url))
            bindText(stmt, 7, documentPath)
            bindText(stmt, 8, previousAppBundle)
            bindText(stmt, 9, Redactor.field(detail))

            if sqlite3_step(stmt) == SQLITE_DONE {
                rowId = sqlite3_last_insert_rowid(db)
            } else {
                print("[Store] Insert failed (insertEvent): \(String(cString: sqlite3_errmsg(db)))")
            }
        }
        return rowId
    }

    struct FileEvent {
        let path: String
        let windowTitle: String?
        let detail: String?
    }

    /// Records file modifications, collapsed to one row per (document_path, UTC day).
    /// A repeat hit on the same file within the same day bumps `change_count` and
    /// refreshes `taken_at`/`window_title`/`detail` instead of inserting a new row.
    /// Async and one transaction per batch, so the main thread never waits on SQLite.
    func upsertFileModified(takenAt: Int64, events: [FileEvent]) {
        guard !events.isEmpty else { return }
        queue.async { [self] in
            // A taken_at range (not date(taken_at)) lets the (document_path, taken_at) index apply.
            let updateSQL = """
            UPDATE context_events
            SET taken_at = ?1, window_title = ?2, detail = ?3, change_count = change_count + 1
            WHERE event_type = 'file_modified' AND document_path = ?4
              AND taken_at >= ?5 AND taken_at < ?6;
            """
            let insertSQL = """
            INSERT INTO context_events (taken_at, event_type, document_path, window_title, detail)
            VALUES (?, 'file_modified', ?, ?, ?);
            """
            var updateStmt: OpaquePointer?
            var insertStmt: OpaquePointer?
            defer {
                sqlite3_finalize(updateStmt)
                sqlite3_finalize(insertStmt)
            }
            guard sqlite3_prepare_v2(db, updateSQL, -1, &updateStmt, nil) == SQLITE_OK,
                  sqlite3_prepare_v2(db, insertSQL, -1, &insertStmt, nil) == SQLITE_OK else {
                print("[Store] Prepare failed (upsertFileModified): \(String(cString: sqlite3_errmsg(db)))")
                return
            }

            let dayStart = takenAt - takenAt % 86_400
            sqlite3_exec(db, "BEGIN IMMEDIATE;", nil, nil, nil)
            for event in events {
                sqlite3_reset(updateStmt)
                sqlite3_bind_int64(updateStmt, 1, takenAt)
                bindText(updateStmt, 2, event.windowTitle)
                bindText(updateStmt, 3, event.detail)
                bindText(updateStmt, 4, event.path)
                sqlite3_bind_int64(updateStmt, 5, dayStart)
                sqlite3_bind_int64(updateStmt, 6, dayStart + 86_400)
                guard sqlite3_step(updateStmt) == SQLITE_DONE else {
                    print("[Store] Update failed (upsertFileModified): \(String(cString: sqlite3_errmsg(db)))")
                    continue
                }
                guard sqlite3_changes(db) == 0 else { continue }

                sqlite3_reset(insertStmt)
                sqlite3_bind_int64(insertStmt, 1, takenAt)
                bindText(insertStmt, 2, event.path)
                bindText(insertStmt, 3, event.windowTitle)
                bindText(insertStmt, 4, event.detail)
                if sqlite3_step(insertStmt) != SQLITE_DONE {
                    print("[Store] Insert failed (upsertFileModified): \(String(cString: sqlite3_errmsg(db)))")
                }
            }
            sqlite3_exec(db, "COMMIT;", nil, nil, nil)
        }
    }

    /// Inserts a structured Slack message. Returns true if a new row was inserted,
    /// false on duplicate (dedupe_hash collision) or error.
    func insertSlackMessage(
        capturedAt: Int64,
        channel: String?,
        sender: String,
        senderExplicit: Bool,
        text: String,
        dateBucket: String?,
        timeLabel: String?,
        permalink: String?,
        reactions: String?,
        replyCount: Int?,
        dedupeHash: String
    ) -> Bool {
        var inserted = false
        queue.sync {
            // Re-seen messages refresh what can change: edits, reactions, reply count, and the
            // conversation label (older captures mislabeled thread-pane messages). A sender read
            // from the message's own button replaces one that was carried, unknown, or captured
            // before sender_explicit existed, so misattributed rows heal when seen again.
            let sql = """
            INSERT INTO slack_messages
              (captured_at, channel, sender, text, date_bucket, time_label, permalink, reactions, reply_count,
               dedupe_hash, sender_explicit)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(dedupe_hash) DO UPDATE SET
              channel = excluded.channel, text = excluded.text, time_label = excluded.time_label,
              reactions = excluded.reactions, reply_count = excluded.reply_count,
              sender = CASE WHEN excluded.sender_explicit = 1 THEN excluded.sender ELSE sender END,
              sender_explicit = MAX(COALESCE(sender_explicit, 0), excluded.sender_explicit)
            WHERE channel IS NOT excluded.channel OR text IS NOT excluded.text
              OR time_label IS NOT excluded.time_label OR reactions IS NOT excluded.reactions
              OR reply_count IS NOT excluded.reply_count
              OR (excluded.sender_explicit = 1 AND (sender_explicit IS NOT 1 OR sender IS NOT excluded.sender))
            RETURNING (captured_at = ?1);
            """
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
                print("[Store] Prepare failed (insertSlackMessage): \(String(cString: sqlite3_errmsg(db)))")
                return
            }
            defer { sqlite3_finalize(stmt) }

            sqlite3_bind_int64(stmt, 1, capturedAt)
            bindText(stmt, 2, channel)
            sqlite3_bind_text(stmt, 3, (sender as NSString).utf8String, -1, nil)
            sqlite3_bind_text(stmt, 4, (Redactor.freeText(text) as NSString).utf8String, -1, nil)
            bindText(stmt, 5, dateBucket)
            bindText(stmt, 6, timeLabel)
            bindText(stmt, 7, permalink)
            bindText(stmt, 8, reactions)
            if let replyCount { sqlite3_bind_int64(stmt, 9, Int64(replyCount)) } else { sqlite3_bind_null(stmt, 9) }
            sqlite3_bind_text(stmt, 10, (dedupeHash as NSString).utf8String, -1, nil)
            sqlite3_bind_int(stmt, 11, senderExplicit ? 1 : 0)

            // A row comes back for an insert or a changed update; only a fresh insert keeps
            // this capture's timestamp, so that's what counts as new.
            switch sqlite3_step(stmt) {
            case SQLITE_ROW: inserted = sqlite3_column_int(stmt, 0) == 1
            case SQLITE_DONE: break
            default: print("[Store] Insert failed (insertSlackMessage): \(String(cString: sqlite3_errmsg(db)))")
            }
        }
        return inserted
    }

    /// Inserts a meeting row at meeting start. `ended_at` is filled in later by
    /// `updateMeeting`; short meetings are removed with `deleteMeeting`.
    func insertMeeting(
        startedAt: Int64,
        endedAt: Int64?,
        platform: String?,
        externalId: String?,
        title: String?,
        url: String?,
        transcriptStatus: String,
        audioPath: String?
    ) -> Int64 {
        var rowId: Int64 = -1
        queue.sync {
            let sql = """
            INSERT INTO meetings (started_at, ended_at, platform, external_id, title, url, transcript_status, audio_path)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?);
            """
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
                print("[Store] Prepare failed (insertMeeting): \(String(cString: sqlite3_errmsg(db)))")
                return
            }
            defer { sqlite3_finalize(stmt) }

            sqlite3_bind_int64(stmt, 1, startedAt)
            if let endedAt {
                sqlite3_bind_int64(stmt, 2, endedAt)
            } else {
                sqlite3_bind_null(stmt, 2)
            }
            bindText(stmt, 3, platform)
            bindText(stmt, 4, externalId)
            bindText(stmt, 5, Redactor.field(title))
            bindText(stmt, 6, Redactor.field(url))
            sqlite3_bind_text(stmt, 7, (transcriptStatus as NSString).utf8String, -1, nil)
            bindText(stmt, 8, audioPath)

            if sqlite3_step(stmt) == SQLITE_DONE {
                rowId = sqlite3_last_insert_rowid(db)
            } else {
                print("[Store] Insert failed (insertMeeting): \(String(cString: sqlite3_errmsg(db)))")
            }
        }
        return rowId
    }

    /// Updates a meeting's end time, transcript status, and where (if anywhere) its audio
    /// lives. `endedAt` nil means still in progress.
    func updateMeeting(id: Int64, endedAt: Int64?, transcriptStatus: String, audioPath: String?) {
        queue.sync {
            let sql = "UPDATE meetings SET ended_at = ?, transcript_status = ?, audio_path = ? WHERE id = ?;"
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
                print("[Store] Prepare failed (updateMeeting): \(String(cString: sqlite3_errmsg(db)))")
                return
            }
            defer { sqlite3_finalize(stmt) }
            if let endedAt { sqlite3_bind_int64(stmt, 1, endedAt) } else { sqlite3_bind_null(stmt, 1) }
            sqlite3_bind_text(stmt, 2, (transcriptStatus as NSString).utf8String, -1, nil)
            bindText(stmt, 3, audioPath)
            sqlite3_bind_int64(stmt, 4, id)
            if sqlite3_step(stmt) != SQLITE_DONE {
                print("[Store] Update failed (updateMeeting): \(String(cString: sqlite3_errmsg(db)))")
            }
        }
    }

    /// Deletes a meeting and its segments (used for meetings under the minimum duration).
    /// Segments are deleted explicitly: `foreign_keys` is not enabled on this connection,
    /// so `ON DELETE CASCADE` would not fire.
    func deleteMeeting(id: Int64) {
        queue.sync {
            for sql in ["DELETE FROM meeting_segments WHERE meeting_id = ?;", "DELETE FROM meetings WHERE id = ?;"] {
                var stmt: OpaquePointer?
                guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { continue }
                sqlite3_bind_int64(stmt, 1, id)
                sqlite3_step(stmt)
                sqlite3_finalize(stmt)
            }
        }
    }

    func fetchSegments(meetingId: Int64) -> [EchoFilter.Segment] {
        var rows: [EchoFilter.Segment] = []
        queue.sync {
            let sql = "SELECT id, started_ms, ended_ms, channel, text FROM meeting_segments WHERE meeting_id = ? ORDER BY started_ms;"
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_int64(stmt, 1, meetingId)
            while sqlite3_step(stmt) == SQLITE_ROW {
                guard let channel = AudioChannel(rawValue: String(cString: sqlite3_column_text(stmt, 3))) else { continue }
                rows.append(EchoFilter.Segment(
                    id: sqlite3_column_int64(stmt, 0), startedMs: sqlite3_column_int64(stmt, 1),
                    endedMs: sqlite3_column_int64(stmt, 2), channel: channel,
                    text: String(cString: sqlite3_column_text(stmt, 4))
                ))
            }
        }
        return rows
    }

    func deleteSegments(ids: [Int64]) {
        guard !ids.isEmpty else { return }
        queue.sync {
            sqlite3_exec(db, "BEGIN;", nil, nil, nil)
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, "DELETE FROM meeting_segments WHERE id = ?;", -1, &stmt, nil) == SQLITE_OK else {
                sqlite3_exec(db, "ROLLBACK;", nil, nil, nil)
                return
            }
            defer { sqlite3_finalize(stmt) }
            for id in ids {
                sqlite3_reset(stmt)
                sqlite3_bind_int64(stmt, 1, id)
                sqlite3_step(stmt)
            }
            sqlite3_exec(db, "COMMIT;", nil, nil, nil)
        }
    }

    /// Meetings still marked 'recording' at daemon startup were interrupted (crash, quit,
    /// reboot). Their audio is still on disk, so mark them 'failed' for a later retry.
    func failInterruptedRecordings() -> Int {
        var changed = 0
        queue.sync {
            if sqlite3_exec(db, "UPDATE meetings SET transcript_status = 'failed' WHERE transcript_status = 'recording';", nil, nil, nil) == SQLITE_OK {
                changed = Int(sqlite3_changes(db))
            }
        }
        return changed
    }

    /// Inserts a batch of transcript segments in one transaction. Returns false if the
    /// batch could not be written (the whole batch is rolled back).
    func insertSegments(meetingId: Int64, _ segments: [MeetingSegment]) -> Bool {
        guard !segments.isEmpty else { return true }
        var ok = false
        queue.sync {
            guard sqlite3_exec(db, "BEGIN;", nil, nil, nil) == SQLITE_OK else { return }
            let sql = """
            INSERT INTO meeting_segments (meeting_id, started_ms, ended_ms, channel, text)
            VALUES (?, ?, ?, ?, ?);
            """
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
                print("[Store] Prepare failed (insertSegments): \(String(cString: sqlite3_errmsg(db)))")
                sqlite3_exec(db, "ROLLBACK;", nil, nil, nil)
                return
            }
            defer { sqlite3_finalize(stmt) }

            for segment in segments {
                sqlite3_reset(stmt)
                sqlite3_bind_int64(stmt, 1, meetingId)
                sqlite3_bind_int64(stmt, 2, segment.startedMs)
                sqlite3_bind_int64(stmt, 3, segment.endedMs)
                sqlite3_bind_text(stmt, 4, (segment.channel.rawValue as NSString).utf8String, -1, nil)
                sqlite3_bind_text(stmt, 5, (Redactor.freeText(segment.text) as NSString).utf8String, -1, nil)
                guard sqlite3_step(stmt) == SQLITE_DONE else {
                    print("[Store] Insert failed (insertSegments): \(String(cString: sqlite3_errmsg(db)))")
                    sqlite3_exec(db, "ROLLBACK;", nil, nil, nil)
                    return
                }
            }
            ok = sqlite3_exec(db, "COMMIT;", nil, nil, nil) == SQLITE_OK
            if !ok { sqlite3_exec(db, "ROLLBACK;", nil, nil, nil) }
        }
        return ok
    }

    // MARK: - Retention

    /// Screenshot paths of samples marked as evidence. Retention never deletes these.
    func evidenceScreenshotPaths() -> Set<String> {
        var paths = Set<String>()
        queue.sync {
            var stmt: OpaquePointer?
            let sql = "SELECT screenshot_path FROM samples WHERE is_evidence = 1 AND screenshot_path != '';"
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
            defer { sqlite3_finalize(stmt) }
            while sqlite3_step(stmt) == SQLITE_ROW {
                if let c = sqlite3_column_text(stmt, 0) { paths.insert(String(cString: c)) }
            }
        }
        return paths
    }

    /// Deletes raw captured rows older than `cutoff`: non-evidence samples, context events,
    /// Slack messages and meeting transcript segments. Meeting rows stay (with their
    /// summaries); their audio paths are cleared and returned for the caller to delete.
    func deleteRawRows(before cutoff: Int64) -> (rows: Int, meetingAudio: [String]) {
        var rows = 0
        var audio: [String] = []
        queue.sync {
            var stmt: OpaquePointer?
            let select = "SELECT audio_path FROM meetings WHERE started_at < ? AND audio_path IS NOT NULL;"
            if sqlite3_prepare_v2(db, select, -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_int64(stmt, 1, cutoff)
                while sqlite3_step(stmt) == SQLITE_ROW {
                    if let c = sqlite3_column_text(stmt, 0) { audio.append(String(cString: c)) }
                }
            }
            sqlite3_finalize(stmt)

            rows += run("DELETE FROM samples WHERE taken_at < ? AND is_evidence = 0;", cutoff)
            rows += run("DELETE FROM context_events WHERE taken_at < ?;", cutoff)
            rows += run("DELETE FROM slack_messages WHERE captured_at < ?;", cutoff)
            rows += run("""
                DELETE FROM meeting_segments
                WHERE meeting_id IN (SELECT id FROM meetings WHERE started_at < ?);
                """, cutoff)
            run("UPDATE meetings SET audio_path = NULL WHERE started_at < ?;", cutoff)
        }
        return (rows, audio)
    }

    /// One-parameter statement on the store queue. Returns rows changed.
    @discardableResult
    private func run(_ sql: String, _ value: Int64) -> Int {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            print("[Store] Prepare failed: \(String(cString: sqlite3_errmsg(db)))")
            return 0
        }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_int64(stmt, 1, value)
        guard sqlite3_step(stmt) == SQLITE_DONE else {
            print("[Store] Step failed: \(String(cString: sqlite3_errmsg(db)))")
            return 0
        }
        return Int(sqlite3_changes(db))
    }

    // MARK: - Helpers

    private func bindText(_ stmt: OpaquePointer?, _ index: Int32, _ value: String?) {
        if let value {
            sqlite3_bind_text(stmt, index, (value as NSString).utf8String, -1, nil)
        } else {
            sqlite3_bind_null(stmt, index)
        }
    }
}
