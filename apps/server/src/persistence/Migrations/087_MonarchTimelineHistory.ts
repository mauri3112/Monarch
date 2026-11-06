import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

interface Source {
  table: string;
  keys: readonly string[];
  project?: string;
  joins?: string;
  when?: string;
  changed?: string;
  id: string;
  at: string;
  entity: string;
  kind: string;
  family: string;
  action: string;
  title: string;
  detail?: string;
  state?: string;
  thread?: string;
  run?: string;
  parents?: string;
}
const threadTable = "orchestration_v2_projection_threads";
const threadJoin = `JOIN ${threadTable} t ON t.thread_id=x.thread_id`;
const projectThread = { joins: threadJoin, project: "t.project_id", thread: "x.thread_id" };
const terminalState =
  "CASE x.status WHEN 'succeeded' THEN 'finished' WHEN 'completed' THEN 'finished' WHEN 'failed' THEN 'failed' WHEN 'interrupted' THEN 'interrupted' WHEN 'cancelled' THEN 'interrupted' ELSE 'recorded' END";
const reviewJoin =
  "LEFT JOIN monarch_review_schedules s ON s.project_id=x.project_id AND s.id=x.schedule_id";
const review = {
  table: "monarch_review_runs",
  keys: ["id"],
  joins: reviewJoin,
  kind: "CASE WHEN s.managed=0 THEN 'review-schedule' ELSE 'review' END",
  family: "CASE WHEN s.managed=0 THEN 'schedule' ELSE 'model' END",
  entity: "CASE WHEN s.managed=0 THEN x.schedule_id ELSE x.id END",
  title: "coalesce(json_extract(s.payload_json,'$.title'),'Project update')",
  run: "x.id",
};
const journal = {
  keys: ["project_id", "run_id", "revision"],
  id: "'journal:' || x.run_id || ':' || x.revision",
  at: "x.recorded_at",
  entity: "x.run_id",
  kind: "'journal'",
  family: "'model'",
  action:
    "CASE WHEN json_array_length(x.entries_json)>0 THEN 'Journal saved' ELSE 'No journal material' END",
  title: "coalesce(json_extract(x.entries_json,'$[0].title'),'Run journal')",
  thread: "x.thread_id",
  run: "x.run_id",
  detail: "'Revision ' || x.revision || ' · ' || json_extract(x.model_json,'$.model')",
  parents: "json_array('turn:' || x.run_id,'stage:' || x.review_run_id || ':journal')",
};
const sources: readonly Source[] = [
  {
    table: "monarch_planning_events",
    keys: ["project_id", "kind", "entity_id", "revision"],
    id: "x.kind || ':' || x.entity_id || ':' || printf('%010d',x.revision)",
    at: "x.at",
    entity: "x.entity_id",
    kind: "x.kind",
    family: "x.kind",
    action: "x.action",
    title: "coalesce(nullif(x.title,''),x.action)",
    state:
      "CASE WHEN x.status IN ('draft','active','paused','achieved','archived') THEN x.status ELSE 'recorded' END",
    detail: "'Revision ' || x.revision",
    parents:
      "CASE WHEN x.revision>1 THEN json_array(x.kind || ':' || x.entity_id || ':0000000001') WHEN x.source_review IS NOT NULL THEN json_array('review:' || x.source_review) ELSE json_array() END",
  },
  ...(
    [
      [
        "'thread:' || x.thread_id || ':created'",
        "x.created_at",
        "Thread started",
        "ready",
        "created_at",
      ],
      [
        "'thread:' || x.thread_id || ':created:finished:' || json_extract(x.payload_json,'$.settledAt')",
        "json_extract(x.payload_json,'$.settledAt')",
        "Thread settled",
        "finished",
        "payload_json",
      ],
      [
        "'thread:' || x.thread_id || ':created:ready:' || json_extract(x.payload_json,'$.unsettledAt')",
        "json_extract(x.payload_json,'$.unsettledAt')",
        "Thread reopened",
        "ready",
        "payload_json",
      ],
      [
        "'thread:' || x.thread_id || ':created:archived:' || x.archived_at",
        "x.archived_at",
        "Thread archived",
        "archived",
        "archived_at",
      ],
    ] as const
  ).map(([id, at, action, state, column]) => ({
    table: threadTable,
    keys: ["thread_id"],
    id,
    at,
    entity: "x.thread_id",
    kind: "'thread'",
    family: "'thread'",
    action: `'${action}'`,
    state: `'${state}'`,
    title: "x.title",
    thread: "x.thread_id",
    when: `${at} IS NOT NULL`,
    changed:
      column === "payload_json"
        ? at.replaceAll("x.", "OLD.") + " IS NOT " + at.replaceAll("x.", "NEW.")
        : `OLD.${column} IS NOT NEW.${column}`,
  })),
  {
    table: "orchestration_v2_projection_runs",
    keys: ["run_id"],
    ...projectThread,
    id: "'turn:' || x.run_id",
    at: "x.completed_at",
    entity: "x.thread_id",
    kind: "'thread'",
    family: "'thread'",
    action: "'Turn ' || replace(x.status,'_',' ')",
    title: "t.title",
    run: "x.run_id",
    state: terminalState,
    when: "x.completed_at IS NOT NULL",
    changed:
      "NEW.completed_at IS NOT OLD.completed_at OR (NEW.completed_at IS NOT NULL AND NEW.status!=OLD.status)",
    parents: "json_array('thread:' || x.thread_id || ':created')",
  },
  {
    table: "orchestration_v2_projection_messages",
    keys: ["message_id"],
    ...projectThread,
    id: "'delivery:' || x.message_id",
    at: "x.created_at",
    entity: "json_extract(x.payload_json,'$.scheduledTaskId')",
    kind: "'prompt-schedule'",
    family: "'schedule'",
    title: "t.title",
    action: "'Scheduled prompt delivered'",
    run: "x.run_id",
    when: "json_extract(x.payload_json,'$.scheduledTaskId') IS NOT NULL",
    changed: "NEW.role='user' AND OLD.run_id IS NOT NEW.run_id",
  },
  {
    table: "monarch_prompt_runs",
    keys: ["project_id", "task_id", "started_at"],
    id: "'prompt:' || x.task_id || ':' || x.started_at",
    at: "coalesce(x.completed_at,x.started_at)",
    entity: "x.task_id",
    kind: "'prompt-schedule'",
    family: "'schedule'",
    title: "x.title",
    action: "'Prompt dispatch ' || x.status",
    state: terminalState,
    thread: "x.thread_id",
    run: "'prompt:' || x.task_id || ':' || x.started_at",
    detail: "coalesce(x.error,'')",
    when: "x.status!='running'",
  },
  {
    table: "scheduled_tasks",
    keys: ["task_id"],
    id: "'schedule:prompt-schedule:' || x.task_id",
    at: "x.created_at",
    entity: "x.task_id",
    kind: "'prompt-schedule'",
    family: "'schedule'",
    title: "x.title",
    action: "'Prompt schedule created'",
    changed: "NEW.project_id!=OLD.project_id",
  },
  {
    table: "monarch_review_schedules",
    keys: ["id"],
    id: "'schedule:review-schedule:' || x.id",
    at: "json_extract(x.payload_json,'$.createdAt')",
    entity: "x.id",
    kind: "'review-schedule'",
    family: "'schedule'",
    title: "json_extract(x.payload_json,'$.title')",
    action: "'Review schedule created'",
    when: "x.managed=0",
    changed: "0",
  },
  {
    ...review,
    id: "'review:' || x.id",
    at: "x.started_at",
    action:
      "CASE WHEN json_extract(x.payload_json,'$.trigger')='retry' THEN 'Update retried' ELSE 'Update started' END",
    changed: "0",
  },
  {
    ...review,
    id: "'review:' || x.id || ':result'",
    at: "json_extract(x.payload_json,'$.completedAt')",
    action:
      "CASE WHEN x.status='succeeded' AND json_array_length(x.payload_json,'$.suggestionIds')=0 AND coalesce(json_extract(x.payload_json,'$.updateSuggestions'),1)!=0 THEN 'No new suggestions' ELSE 'Update ' || x.status END",
    when: "json_extract(x.payload_json,'$.completedAt') IS NOT NULL",
    state: terminalState,
    detail:
      "coalesce(json_extract(x.payload_json,'$.error'),json_extract(x.payload_json,'$.summary'),'')",
    parents: "json_array('review:' || x.id)",
    changed: "NEW.status!=OLD.status",
  },
  { table: "monarch_run_journals", ...journal },
  { table: "monarch_journal_history", ...journal },
  {
    table: "monarch_review_stages",
    keys: ["project_id", "review_run_id", "stage"],
    id: "'stage:' || x.review_run_id || ':' || x.stage",
    at: "x.completed_at",
    entity: "x.review_run_id",
    kind: "'review'",
    family: "'model'",
    title: "CASE x.stage WHEN 'journal' THEN 'Write run journals' ELSE 'Review suggestions' END",
    action: "'Model stage ' || x.status",
    detail: "coalesce(x.error,json_extract(x.model_json,'$.model'),'')",
    state: terminalState,
    run: "x.review_run_id",
    parents: "json_array('review:' || x.review_run_id)",
    when: "x.completed_at IS NOT NULL",
  },
];
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE monarch_timeline_visibility(project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL)`;
  const bump = (project: string) =>
    `INSERT INTO monarch_timeline_visibility VALUES(${project},1) ON CONFLICT(project_id) DO UPDATE SET revision=revision+1;`;
  yield* sql.unsafe(`CREATE TRIGGER monarch_history_thread_scope AFTER UPDATE OF project_id,deleted_at ON orchestration_v2_projection_threads
    WHEN OLD.project_id!=NEW.project_id OR OLD.deleted_at IS NOT NEW.deleted_at BEGIN ${bump("OLD.project_id")} ${bump("NEW.project_id")} END`);
  yield* sql.unsafe(
    `CREATE TRIGGER monarch_history_thread_removed AFTER DELETE ON orchestration_v2_projection_threads BEGIN ${bump("OLD.project_id")} END`,
  );
  for (const action of ["INSERT", "UPDATE OF settings_json", "DELETE"]) {
    const [prefix] = action.split(" ");
    const changed =
      prefix === "UPDATE"
        ? "WHEN json_extract(OLD.settings_json,'$.excludedThreadIds') IS NOT json_extract(NEW.settings_json,'$.excludedThreadIds')"
        : "";
    yield* sql.unsafe(
      `CREATE TRIGGER monarch_history_context_${prefix} AFTER ${action} ON monarch_project_context ${changed} BEGIN ${bump(prefix === "DELETE" ? "OLD.project_id" : "NEW.project_id")} END`,
    );
  }
  // This compact index keeps page reads proportional to page size, including projects with years of turns.
  yield* sql`CREATE TABLE monarch_timeline_history(project_id TEXT NOT NULL,id TEXT NOT NULL,at TEXT NOT NULL,
    entity_kind TEXT NOT NULL,entity_id TEXT NOT NULL,family TEXT NOT NULL,action TEXT NOT NULL,title TEXT NOT NULL,detail TEXT NOT NULL,
    state TEXT NOT NULL,thread_id TEXT,run_id TEXT,parents TEXT NOT NULL,PRIMARY KEY(project_id,id))`;
  yield* sql`CREATE INDEX monarch_timeline_page ON monarch_timeline_history(project_id,at DESC,id DESC)`;
  for (const [i, s] of sources.entries()) {
    const fields = [
      s.project ?? "x.project_id",
      s.id,
      s.at,
      s.kind,
      s.entity,
      s.family,
      s.action,
      `coalesce(${s.title},'')`,
      s.detail ? `coalesce(${s.detail},'')` : "''",
      s.state ?? "'recorded'",
      s.thread ?? "NULL",
      s.run ?? "NULL",
      s.parents ?? "json_array()",
    ];
    const upsert =
      " ON CONFLICT(project_id,id) DO UPDATE SET at=excluded.at,title=excluded.title,action=excluded.action,state=excluded.state,detail=excluded.detail,thread_id=excluded.thread_id,run_id=excluded.run_id,parents=excluded.parents";
    const select = `INSERT INTO monarch_timeline_history SELECT ${fields.join(",")} FROM ${s.table} x ${s.joins ?? ""} WHERE (${s.when ?? "1"}) AND ${s.at} IS NOT NULL`;
    yield* sql.unsafe(select + upsert);
    const insert = `${select} AND ${s.keys.map((k) => `x.${k}=NEW.${k}`).join(" AND ")}${upsert};`;
    yield* sql.unsafe(
      `CREATE TRIGGER monarch_history_${i}_insert AFTER INSERT ON ${s.table} BEGIN ${insert} END`,
    );
    if (s.changed !== "0")
      yield* sql.unsafe(
        `CREATE TRIGGER monarch_history_${i}_update AFTER UPDATE ON ${s.table} WHEN ${s.changed ?? "1"} BEGIN ${insert} END`,
      );
  }
});
