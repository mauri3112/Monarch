import { describe, it, assert } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import * as VoiceSessions from "./VoiceSessions.ts";

const input = { sessionId: "voice-1", threadId: ThreadId.make("thread-1"), sdp: "private-offer" };
describe("VoiceSessions", () => {
  it.effect("binds control and SDP to the owner and admits a connection only once", () =>
    Effect.gen(function* () {
      const sessions = yield* VoiceSessions.VoiceSessions;
      const answer = yield* sessions.prepare(input, "owner");
      assert.equal((yield* sessions.stop(input, "stranger").pipe(Effect.flip)).reason, "owner");
      assert.equal(
        (yield* sessions
          .state({ ...input, threadId: ThreadId.make("elsewhere") }, "owner")
          .pipe(Effect.flip)).reason,
        "owner",
      );
      const connection = yield* sessions.claim(input.sessionId, input.threadId);
      assert.equal(connection.sdp, "private-offer");
      assert.equal(
        (yield* sessions.claim(input.sessionId, input.threadId).pipe(Effect.flip)).reason,
        "expired",
      );
      yield* connection.answer("private-answer");
      assert.equal(yield* Deferred.await(answer), "private-answer");
      assert.deepEqual(yield* sessions.state(input, "owner"), {
        sessionId: input.sessionId,
        status: "connected",
        reason: "",
      });
      yield* connection.closed;
    }).pipe(Effect.provide(VoiceSessions.layer)),
  );
  it.effect("cancels a pending offer and refuses stale startup", () =>
    Effect.gen(function* () {
      const sessions = yield* VoiceSessions.VoiceSessions;
      const answer = yield* sessions.prepare(input, "owner");
      yield* sessions.stop(input, "owner");
      assert.equal((yield* Deferred.await(answer).pipe(Effect.flip)).reason, "cancelled");
      assert.equal(
        (yield* sessions.claim(input.sessionId, input.threadId).pipe(Effect.flip)).reason,
        "expired",
      );
      yield* sessions.stop(input, "owner");
    }).pipe(Effect.provide(VoiceSessions.layer)),
  );
  it.effect("stops a connected voice session when its browser lease expires", () =>
    Effect.gen(function* () {
      const sessions = yield* VoiceSessions.VoiceSessions;
      yield* sessions.prepare(input, "owner");
      const connection = yield* sessions.claim(input.sessionId, input.threadId);
      const stopped = yield* Deferred.make<void>();
      yield* connection.installStop(
        Deferred.succeed(stopped, undefined).pipe(Effect.andThen(connection.closed)),
      );
      yield* connection.answer("answer");
      yield* TestClock.adjust("46 seconds");
      yield* Deferred.await(stopped);
      assert.equal((yield* sessions.state(input, "owner")).status, "closed");
    }).pipe(Effect.provide(VoiceSessions.layer)),
  );
});
