import {
  VoiceError,
  type VoiceStartInput,
  type VoiceSessionInput,
  type VoiceState,
} from "@t3tools/contracts";
import type { ProviderVoiceConnection } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

interface Entry {
  readonly input: VoiceStartInput;
  readonly owner: string;
  readonly answer: Deferred.Deferred<string, VoiceError>;
  readonly connection: ProviderVoiceConnection;
  state: VoiceState;
  stop: Effect.Effect<void> | undefined;
  touchedAt: number;
  claimed: boolean;
}
export class VoiceSessions extends Context.Service<
  VoiceSessions,
  {
    readonly prepare: (
      input: VoiceStartInput,
      owner: string,
    ) => Effect.Effect<Deferred.Deferred<string, VoiceError>, VoiceError>;
    readonly claim: (
      sessionId: string,
      threadId: string,
    ) => Effect.Effect<ProviderVoiceConnection, VoiceError>;
    readonly stop: (input: VoiceSessionInput, owner: string) => Effect.Effect<void, VoiceError>;
    readonly state: (
      input: VoiceSessionInput,
      owner: string,
    ) => Effect.Effect<VoiceState, VoiceError>;
    readonly fail: (sessionId: string, error: VoiceError) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/VoiceSessions") {}

const make = Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  const entries = new Map<string, Entry>();
  const finish = Effect.fn("VoiceSessions.finish")(function* (entry: Entry, error?: VoiceError) {
    if (entry.state.status === "closed" || entry.state.status === "error") return;
    entry.state = {
      sessionId: entry.input.sessionId,
      status: error ? "error" : "closed",
      reason: error?.message ?? "",
    };
    yield* Deferred.fail(entry.answer, error ?? new VoiceError({ reason: "cancelled" }));
    yield* Effect.sleep("1 minute").pipe(
      Effect.andThen(Effect.sync(() => entries.delete(entry.input.sessionId))),
      Effect.forkIn(scope),
    );
  });
  const stopEntry = Effect.fn("VoiceSessions.stopEntry")(function* (entry: Entry) {
    if (entry.state.status === "closed" || entry.state.status === "error") return;
    entry.state = { ...entry.state, status: "stopping" };
    yield* Deferred.fail(entry.answer, new VoiceError({ reason: "cancelled" }));
    if (entry.stop) yield* entry.stop;
    else yield* finish(entry);
  });
  const owned = Effect.fn("VoiceSessions.owned")(function* (
    input: VoiceSessionInput,
    owner: string,
  ) {
    const entry = entries.get(input.sessionId);
    if (!entry) return yield* new VoiceError({ reason: "expired" });
    if (entry.owner !== owner || entry.input.threadId !== input.threadId)
      return yield* new VoiceError({ reason: "owner" });
    return entry;
  });
  yield* Effect.addFinalizer(() => Effect.forEach(entries.values(), stopEntry, { discard: true }));
  return VoiceSessions.of({
    prepare: Effect.fn("VoiceSessions.prepare")(function* (input, owner) {
      if (
        entries.has(input.sessionId) ||
        [...entries.values()].some(
          (e) =>
            e.input.threadId === input.threadId &&
            e.state.status !== "closed" &&
            e.state.status !== "error",
        )
      )
        return yield* new VoiceError({ reason: "busy" });
      const answer = yield* Deferred.make<string, VoiceError>();
      const now = yield* Clock.currentTimeMillis;
      const entry: Entry = {
        input,
        owner,
        answer,
        touchedAt: now,
        claimed: false,
        stop: undefined,
        state: { sessionId: input.sessionId, status: "starting", reason: "" },
        connection: {
          sessionId: input.sessionId,
          sdp: input.sdp,
          answer: Effect.fn("VoiceSessions.answer")(function* (sdp) {
            if (entry.state.status !== "starting") return;
            entry.state = { ...entry.state, status: "connected" };
            yield* Deferred.succeed(answer, sdp);
          }),
          fail: (reason) => finish(entry, new VoiceError({ reason })),
          closed: Effect.suspend(() => finish(entry)),
          installStop: Effect.fn("VoiceSessions.installStop")(function* (stop) {
            entry.stop = stop;
            if (entry.state.status !== "starting" && entry.state.status !== "connected")
              yield* stop;
          }),
        },
      };
      entries.set(input.sessionId, entry);
      yield* Effect.gen(function* () {
        while (entry.state.status === "starting" || entry.state.status === "connected") {
          yield* Effect.sleep("15 seconds");
          const now = yield* Clock.currentTimeMillis;
          if (now - entry.touchedAt > 30_000 || now - entry.touchedAt < 0) yield* stopEntry(entry);
        }
      }).pipe(Effect.forkIn(scope));
      return answer;
    }),
    claim: Effect.fn("VoiceSessions.claim")(function* (sessionId, threadId) {
      const entry = entries.get(sessionId);
      if (
        !entry ||
        entry.input.threadId !== threadId ||
        entry.claimed ||
        entry.state.status !== "starting"
      )
        return yield* new VoiceError({ reason: "expired" });
      entry.claimed = true;
      return entry.connection;
    }),
    stop: Effect.fn("VoiceSessions.stop")(function* (input, owner) {
      const entry = yield* owned(input, owner);
      yield* stopEntry(entry);
    }),
    state: Effect.fn("VoiceSessions.state")(function* (input, owner) {
      const entry = yield* owned(input, owner);
      entry.touchedAt = yield* Clock.currentTimeMillis;
      return entry.state;
    }),
    fail: Effect.fn("VoiceSessions.fail")((sessionId, error) => {
      const entry = entries.get(sessionId);
      return entry ? finish(entry, error) : Effect.void;
    }),
  });
});
export const layer = Layer.effect(VoiceSessions, make);
