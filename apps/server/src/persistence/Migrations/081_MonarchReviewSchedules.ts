import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE monarch_review_schedules (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    next_run_at TEXT,
    active_run_id TEXT,
    payload_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX monarch_review_schedules_due ON monarch_review_schedules(enabled, next_run_at)
    WHERE enabled = 1 AND next_run_at IS NOT NULL`;
  yield* sql`CREATE INDEX monarch_review_schedules_project ON monarch_review_schedules(project_id)`;
  yield* sql`CREATE TABLE monarch_review_runs (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    lease_until TEXT NOT NULL,
    payload_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX monarch_review_runs_history ON monarch_review_runs(schedule_id, started_at DESC)`;
  yield* sql`CREATE INDEX monarch_review_runs_recovery ON monarch_review_runs(status, lease_until)
    WHERE status = 'running'`;
});
