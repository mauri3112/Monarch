import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE monarch_run_journals (
    project_id TEXT NOT NULL, run_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    completed_at TEXT NOT NULL, branch TEXT, worktree_path TEXT,
    entries_json TEXT NOT NULL, review_run_id TEXT NOT NULL, model_json TEXT NOT NULL,
    started_at TEXT NOT NULL, recorded_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(project_id, run_id)
  )`;
  yield* sql`CREATE TABLE monarch_journal_history AS SELECT * FROM monarch_run_journals WHERE 0`;
  yield* sql`CREATE UNIQUE INDEX monarch_journal_version ON monarch_journal_history(project_id, run_id, revision)`;
  yield* sql`CREATE INDEX monarch_journal_history_time ON monarch_journal_history(project_id,recorded_at DESC)`;
  yield* sql`CREATE VIEW monarch_run_journal_revisions AS SELECT * FROM monarch_run_journals UNION ALL SELECT * FROM monarch_journal_history`;
  yield* sql`CREATE TRIGGER monarch_journal_revision BEFORE UPDATE ON monarch_run_journals BEGIN
    INSERT INTO monarch_journal_history SELECT * FROM monarch_run_journals WHERE project_id=OLD.project_id AND run_id=OLD.run_id;
  END`;
  yield* sql`ALTER TABLE monarch_continuity_sources ADD COLUMN journal_revision INTEGER NOT NULL DEFAULT 1`;
  yield* sql`CREATE INDEX monarch_recent_journals ON monarch_run_journals(project_id, completed_at DESC, run_id DESC)`;
  yield* sql`CREATE TABLE monarch_review_stages (
    project_id TEXT NOT NULL, review_run_id TEXT NOT NULL, stage TEXT NOT NULL,
    source_run_ids_json TEXT NOT NULL, model_json TEXT NOT NULL, started_at TEXT NOT NULL,
    completed_at TEXT, status TEXT NOT NULL, error TEXT, source_refs_json TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(review_run_id,stage)
  )`;
  yield* sql`CREATE INDEX monarch_recent_stages ON monarch_review_stages(project_id,started_at DESC,review_run_id,stage)`;
});
