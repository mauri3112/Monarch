import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE monarch_project_context (
    project_id TEXT PRIMARY KEY REFERENCES projection_projects(project_id),
    revision INTEGER NOT NULL DEFAULT 0,
    settings_revision INTEGER NOT NULL DEFAULT 0,
    settings_json TEXT NOT NULL, enabled_at TEXT, updated_at TEXT, enabled_sequence INTEGER, enabled_target_fingerprint TEXT
  )`;
  yield* sql`CREATE TABLE monarch_context_entries (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projection_projects(project_id),
    revision INTEGER NOT NULL, removed_at TEXT, payload_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX monarch_context_entries_project ON monarch_context_entries(project_id, removed_at, id)`;
  yield* sql`CREATE TABLE monarch_context_history (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL,
    entry_id TEXT NOT NULL, revision INTEGER NOT NULL, action TEXT NOT NULL,
    payload_json TEXT NOT NULL, UNIQUE(entry_id, revision)
  )`;
  yield* sql`CREATE INDEX monarch_context_history_project ON monarch_context_history(project_id, sequence DESC)`;
  yield* sql`CREATE INDEX monarch_context_history_entry ON monarch_context_history(project_id, entry_id, sequence DESC)`;
  yield* sql`CREATE TABLE monarch_context_material_keys (
    project_id TEXT NOT NULL, material_key TEXT NOT NULL, PRIMARY KEY(project_id, material_key)
  )`;
  yield* sql`CREATE TABLE monarch_context_generations (
    project_id TEXT NOT NULL, generation_id TEXT NOT NULL, context_revision INTEGER NOT NULL,
    PRIMARY KEY(project_id, generation_id)
  )`;
});
