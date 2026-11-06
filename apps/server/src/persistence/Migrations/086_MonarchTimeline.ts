import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE monarch_planning_events (
    project_id TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL, revision INTEGER NOT NULL,
    at TEXT NOT NULL, action TEXT NOT NULL, title TEXT NOT NULL, status TEXT, source_review TEXT,
    PRIMARY KEY(project_id,kind,entity_id,revision)
  )`;
  yield* sql`CREATE INDEX monarch_planning_recent ON monarch_planning_events(project_id, at DESC)`;
  for (const [table, kind, created, transitions] of [
    [
      "monarch_targets",
      "target",
      "Target added",
      `CASE
      WHEN oldStatus IS newStatus THEN 'Target edited'
      WHEN newStatus='archived' THEN 'Target archived'
      WHEN newStatus='achieved' THEN 'Target achieved'
      WHEN newStatus='paused' THEN 'Target paused'
      WHEN oldStatus IN ('archived','achieved','paused') THEN 'Target restored'
      ELSE 'Target updated' END`,
    ],
    [
      "monarch_suggestions",
      "suggestion",
      "Thread suggested",
      `CASE
      WHEN newStatus='used' AND oldStatus!='used' THEN 'Suggestion used'
      WHEN newStatus='dismissed' AND oldStatus!='dismissed' THEN 'Suggestion dismissed'
      WHEN newStatus='suggested' AND oldStatus='dismissed' THEN 'Suggestion restored'
      WHEN json_extract(OLD.payload_json,'$.draftThreadId') IS NULL AND json_extract(NEW.payload_json,'$.draftThreadId') IS NOT NULL THEN 'Draft prepared'
      ELSE 'Suggestion edited' END`,
    ],
  ] as const) {
    // Old revisions only retain their current title and status. Describe the known revision without inferring an earlier change.
    yield* sql.unsafe(`INSERT INTO monarch_planning_events
      SELECT project_id,'${kind}',id,1,json_extract(payload_json,'$.createdAt'),'${created}',
        CASE WHEN revision=1 THEN json_extract(payload_json,'$.title') ELSE '' END,
        CASE WHEN revision=1 THEN json_extract(payload_json,'$.status') END,json_extract(payload_json,'$.sourceRunId') FROM ${table}
      UNION ALL SELECT project_id,'${kind}',id,revision,json_extract(payload_json,'$.updatedAt'),'Latest known revision',
        json_extract(payload_json,'$.title'),json_extract(payload_json,'$.status'),json_extract(payload_json,'$.sourceRunId')
        FROM ${table} WHERE revision>1`);
    yield* sql.unsafe(`CREATE TRIGGER ${table}_timeline_insert AFTER INSERT ON ${table}
      BEGIN INSERT INTO monarch_planning_events VALUES(NEW.project_id,'${kind}',NEW.id,NEW.revision,
        json_extract(NEW.payload_json,'$.createdAt'),'${created}',json_extract(NEW.payload_json,'$.title'),
        json_extract(NEW.payload_json,'$.status'),json_extract(NEW.payload_json,'$.sourceRunId')); END`);
    yield* sql.unsafe(`CREATE TRIGGER ${table}_timeline_update AFTER UPDATE OF revision ON ${table}
      WHEN OLD.revision != NEW.revision
      BEGIN INSERT INTO monarch_planning_events
        SELECT NEW.project_id,'${kind}',NEW.id,NEW.revision,json_extract(NEW.payload_json,'$.updatedAt'),
          ${transitions}, json_extract(NEW.payload_json,'$.title'),newStatus,json_extract(NEW.payload_json,'$.sourceRunId')
        FROM (SELECT json_extract(NEW.payload_json,'$.status') AS newStatus,json_extract(OLD.payload_json,'$.status') AS oldStatus); END`);
  }
  yield* sql`CREATE TABLE monarch_prompt_runs (
    project_id TEXT NOT NULL, task_id TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT,
    status TEXT NOT NULL, title TEXT NOT NULL, error TEXT, thread_id TEXT, created_thread INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(project_id, task_id, started_at)
  )`;
  yield* sql`CREATE INDEX monarch_prompt_recent ON monarch_prompt_runs(project_id,started_at DESC)`;
  yield* sql`CREATE INDEX monarch_prompt_thread ON monarch_prompt_runs(project_id,thread_id) WHERE thread_id IS NOT NULL`;
  yield* sql`CREATE INDEX monarch_suggestion_thread ON monarch_suggestions(project_id,json_extract(payload_json,'$.draftThreadId'))`;
  yield* sql`INSERT INTO monarch_prompt_runs(project_id, task_id, started_at, status, title, error)
    SELECT project_id, task_id, last_run_at, last_run_status, title, last_run_error FROM scheduled_tasks
    WHERE last_run_at IS NOT NULL AND last_run_status IN ('running','failed','succeeded')`;
  yield* sql`CREATE TRIGGER monarch_prompt_record AFTER UPDATE OF last_run_status, last_run_at ON scheduled_tasks
    WHEN NEW.last_run_at IS NOT NULL AND (NEW.last_run_status IS NOT OLD.last_run_status OR NEW.last_run_at IS NOT OLD.last_run_at)
      AND NEW.last_run_status IN ('running','failed','succeeded')
    BEGIN INSERT INTO monarch_prompt_runs(project_id,task_id,started_at,completed_at,status,title,error)
      VALUES(NEW.project_id,NEW.task_id,NEW.last_run_at,CASE WHEN NEW.last_run_status!='running' THEN NEW.updated_at END,
        NEW.last_run_status,NEW.title,NEW.last_run_error)
      ON CONFLICT(project_id, task_id, started_at) DO UPDATE SET completed_at=excluded.completed_at,status=excluded.status,error=excluded.error;
    END`;
  yield* sql`CREATE INDEX monarch_scheduled_message ON orchestration_v2_projection_messages
    (thread_id,created_at DESC) WHERE json_extract(payload_json,'$.scheduledTaskId') IS NOT NULL`;
});
