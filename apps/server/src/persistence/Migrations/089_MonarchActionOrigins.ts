import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE monarch_proposal_target_origins (
    project_id TEXT NOT NULL, event_id TEXT NOT NULL, targets_json TEXT NOT NULL,
    PRIMARY KEY(project_id,event_id)
  ) WITHOUT ROWID`;
  // Before receipts, only the latest editable snapshot (followed by status/draft changes) proves a Target set.
  yield* sql`WITH snapshots AS (
    SELECT s.project_id,s.id,s.revision,json_extract(s.payload_json,'$.targets') targets,
      (SELECT max(p.revision) FROM monarch_planning_events p WHERE p.project_id=s.project_id
        AND p.kind='suggestion' AND p.entity_id=s.id AND p.revision<=s.revision
        AND p.action IN ('Thread suggested','Suggestion edited','Latest known revision')) known
    FROM monarch_suggestions s
  ) INSERT INTO monarch_proposal_target_origins
      SELECT project_id,'suggestion:' || id || ':' || printf('%010d',known),targets FROM snapshots s
      WHERE json_array_length(targets)>0 AND known IS NOT NULL AND revision-known=(
        SELECT count(*) FROM monarch_planning_events e WHERE e.project_id=s.project_id AND e.kind='suggestion'
          AND e.entity_id=s.id AND e.revision>known AND e.revision<=s.revision)`;
  const insertRefs = `INSERT INTO monarch_proposal_target_origins VALUES(
    NEW.project_id,'suggestion:' || NEW.id || ':' || printf('%010d',NEW.revision),coalesce(json_extract(NEW.payload_json,'$.targets'),'[]'));`;
  yield* sql.unsafe(`CREATE TRIGGER monarch_proposal_created_origins AFTER INSERT ON monarch_suggestions
    WHEN json_array_length(NEW.payload_json,'$.targets')>0 BEGIN ${insertRefs} END`);
  const pairs = (row: "OLD" | "NEW") =>
    `SELECT json_extract(value,'$.targetId'),json_extract(value,'$.revision') FROM json_each(${row}.payload_json,'$.targets')`;
  yield* sql.unsafe(`CREATE TRIGGER monarch_proposal_changed_origins AFTER UPDATE OF payload_json ON monarch_suggestions
    WHEN json_extract(OLD.payload_json,'$.targets') IS NOT json_extract(NEW.payload_json,'$.targets')
      AND (EXISTS(${pairs("NEW")} EXCEPT ${pairs("OLD")}) OR EXISTS(${pairs("OLD")} EXCEPT ${pairs("NEW")}))
    BEGIN
      SELECT CASE WHEN NEW.revision<=OLD.revision THEN RAISE(ABORT,'A proposal Target change requires a new revision') END;
      ${insertRefs}
    END`);
  yield* sql`CREATE TABLE monarch_prompt_creation_origins (
    project_id TEXT NOT NULL, task_id TEXT NOT NULL, created_at TEXT NOT NULL, thread_id TEXT,
    PRIMARY KEY(project_id,task_id,created_at)
  ) WITHOUT ROWID`;
  yield* sql`INSERT INTO monarch_prompt_creation_origins
    SELECT project_id,task_id,created_at,thread_id FROM scheduled_tasks
    WHERE task_id IS NOT NULL AND created_at=updated_at`;
  yield* sql`CREATE TRIGGER monarch_prompt_created_origin AFTER INSERT ON scheduled_tasks
    WHEN NEW.task_id IS NOT NULL BEGIN
      INSERT INTO monarch_prompt_creation_origins VALUES(NEW.project_id,NEW.task_id,NEW.created_at,NEW.thread_id)
        ON CONFLICT(project_id,task_id,created_at) DO NOTHING;
    END`;
});
