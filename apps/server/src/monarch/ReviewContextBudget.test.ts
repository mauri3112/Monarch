import * as NodeAssert from "node:assert/strict";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { encodeReviewContext, REVIEW_CONTEXT_MAX_BYTES } from "./ReviewContextBudget.ts";

describe("ReviewContextBudget", () => {
  it.effect("trims content while retaining source and entry identifiers", () =>
    Effect.gen(function* () {
      const input = {
        currentEntries: Array.from({ length: 20 }, (_, index) => ({
          id: `entry-${index}`,
          kind: "decision",
          scope: "branch",
          body: "🧪".repeat(2_000),
          sourceRefs: [{ threadId: `thread-${index}`, runId: `run-${index}` }],
        })),
      };
      const encoded = yield* encodeReviewContext(input);
      const decoded = JSON.parse(encoded);
      NodeAssert.ok(Buffer.byteLength(encoded, "utf8") <= REVIEW_CONTEXT_MAX_BYTES);
      NodeAssert.equal(decoded.inputTruncated, true);
      NodeAssert.equal(decoded.currentEntries.length, 20);
      NodeAssert.equal(decoded.currentEntries[19].id, "entry-19");
      NodeAssert.deepEqual(decoded.currentEntries[19].sourceRefs, [
        { threadId: "thread-19", runId: "run-19" },
      ]);
      NodeAssert.ok(decoded.currentEntries[0].body.length < input.currentEntries[0]!.body.length);
    }),
  );

  it.effect("fails if identifiers and lineage alone exceed the cap", () =>
    Effect.gen(function* () {
      const input = {
        sourceRefs: Array.from({ length: 5_000 }, (_, index) => ({
          threadId: `thread-${index}`,
          runId: `run-${index}`,
        })),
      };
      const exit = yield* Effect.exit(encodeReviewContext(input));
      NodeAssert.equal(exit._tag, "Failure");
    }),
  );
});
