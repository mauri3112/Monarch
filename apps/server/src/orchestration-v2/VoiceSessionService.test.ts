import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as VoiceSessions from "./VoiceSessions.ts";
import * as VoiceService from "./VoiceSessionService.ts";

const threadId = ThreadId.make("voice-admission-thread");
const instanceId = ProviderInstanceId.make("codex-voice-native");
const input = { threadId, sessionId: "voice-admission", sdp: "private-offer" };
const projection = (busy: boolean) =>
  ({
    thread: { id: threadId, modelSelection: { instanceId, model: "gpt-5.4" } },
    runs: busy ? [{ status: "running" }] : [],
  }) as unknown as OrchestrationV2ThreadProjection;
const dependencies = (options: {
  busy?: boolean;
  managed?: boolean;
  dispatch: ThreadManagement.ThreadManagementService["Service"]["dispatch"];
}) =>
  Layer.mergeAll(
    ServerSettings.layerTest({
      providerInstances: {
        [instanceId]: {
          driver: "codex",
          config: { setupMode: options.managed ? "managed" : "existing" },
        },
      },
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadRecords: () => Effect.succeed(projection(options.busy ?? false)),
    }),
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: () =>
        Effect.succeed({ instanceId, driverKind: "codex", enabled: true } as never),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({ dispatch: options.dispatch }),
  );

describe("VoiceSessionService admission", () => {
  it.effect(
    "admits the private offer before trusted dispatch and unwinds cancellation while SDP is pending",
    () =>
      Effect.gen(function* () {
        const sessions = yield* VoiceSessions.VoiceSessions;
        const admitted = yield* Deferred.make<void>();
        const stopped = yield* Deferred.make<void>();
        const commands: OrchestrationV2ServerCommand[] = [];
        const service = yield* VoiceService.VoiceSessionService.pipe(
          Effect.provide(
            VoiceService.layer.pipe(
              Layer.provide(
                dependencies({
                  dispatch: (command) =>
                    Effect.gen(function* () {
                      commands.push(command);
                      const connection = yield* sessions
                        .claim(input.sessionId, threadId)
                        .pipe(Effect.orDie);
                      assert.equal(connection.sdp, "private-offer");
                      yield* connection.installStop(
                        Deferred.succeed(stopped, undefined).pipe(
                          Effect.andThen(connection.closed),
                        ),
                      );
                      yield* Deferred.succeed(admitted, undefined);
                      return { sequence: 1, events: [] } as never;
                    }),
                }),
              ),
            ),
          ),
        );
        const start = yield* service.start(input, "owner").pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(admitted);
        assert.lengthOf(commands, 1);
        assert.include(commands[0], { type: "message.dispatch", voiceSessionId: input.sessionId });
        assert.notProperty(commands[0], "sdp");
        yield* service.stop(input, "owner");
        yield* Deferred.await(stopped);
        const result = yield* Fiber.join(start);
        assert.equal(result._tag, "Failure");
        assert.equal((yield* service.state(input, "owner")).status, "closed");
        assert.equal(
          (yield* sessions.claim(input.sessionId, threadId).pipe(Effect.flip)).reason,
          "expired",
        );
      }).pipe(Effect.provide(VoiceSessions.layer)),
  );

  it.effect.each(["busy", "managed"] as const)(
    "refuses %s admission before dispatch or offer storage",
    (reason) =>
      Effect.gen(function* () {
        const sessions = yield* VoiceSessions.VoiceSessions;
        let dispatches = 0;
        const service = yield* VoiceService.VoiceSessionService.pipe(
          Effect.provide(
            VoiceService.layer.pipe(
              Layer.provide(
                dependencies({
                  busy: reason === "busy",
                  managed: reason === "managed",
                  dispatch: () =>
                    Effect.sync(() => {
                      dispatches++;
                      return {} as never;
                    }),
                }),
              ),
            ),
          ),
        );
        const error = yield* service.start(input, "owner").pipe(Effect.flip);
        assert.equal(error.reason, reason === "busy" ? "busy" : "unsupported");
        assert.equal(dispatches, 0);
        assert.equal(
          (yield* sessions.claim(input.sessionId, threadId).pipe(Effect.flip)).reason,
          "expired",
        );
      }).pipe(Effect.provide(VoiceSessions.layer)),
  );
});
