import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX monarch_reserved_thread ON monarch_suggestions(json_extract(payload_json,'$.draftThreadId'))
    WHERE json_extract(payload_json,'$.draftThreadId') IS NOT NULL`;
});
