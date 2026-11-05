import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE monarch_review_schedules ADD COLUMN managed INTEGER NOT NULL DEFAULT 0`;
  yield* sql`CREATE TABLE monarch_continuity_queue (
    project_id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL UNIQUE,
    cursor_sequence INTEGER NOT NULL,
    target_fingerprint TEXT NOT NULL,
    requested_version INTEGER NOT NULL DEFAULT 0,
    attempted_version INTEGER NOT NULL DEFAULT 0,
    completed_version INTEGER NOT NULL DEFAULT 0,
    trigger TEXT NOT NULL DEFAULT 'refresh',
    update_context INTEGER NOT NULL DEFAULT 1,
    update_suggestions INTEGER NOT NULL DEFAULT 1,
    last_error TEXT,
    enabled_sequence INTEGER
  )`;
  yield* sql`CREATE TABLE monarch_continuity_sources (
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    event_sequence INTEGER NOT NULL,
    captured INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(project_id, run_id)
  )`;
  yield* sql`CREATE INDEX monarch_continuity_pending ON monarch_continuity_sources(project_id, captured, event_sequence)`;
  yield* sql`CREATE INDEX monarch_continuity_run_history ON monarch_review_runs(project_id, started_at)`;
  yield* sql`CREATE INDEX monarch_continuity_completed_events ON orchestration_events(sequence, stream_id)
    WHERE event_type = 'run.updated' AND json_extract(payload_json, '$.status') = 'completed'`;
});
