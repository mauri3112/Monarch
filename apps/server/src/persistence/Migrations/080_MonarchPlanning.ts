import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE monarch_targets (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projection_projects(project_id),
      revision INTEGER NOT NULL CHECK(revision > 0), payload_json TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX monarch_targets_project_idx ON monarch_targets(project_id, id)`;
  yield* sql`
    CREATE TABLE monarch_suggestions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projection_projects(project_id),
      revision INTEGER NOT NULL CHECK(revision > 0), dedupe_key TEXT, payload_json TEXT NOT NULL,
      UNIQUE(project_id, dedupe_key)
    )
  `;
  yield* sql`CREATE INDEX monarch_suggestions_project_idx ON monarch_suggestions(project_id, id)`;
});
