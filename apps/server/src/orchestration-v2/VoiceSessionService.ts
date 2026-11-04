import {
  CommandId,
  MessageId,
  CodexSettings,
  VoiceError,
  type ThreadId,
  type VoiceCapability,
  type VoiceStartInput,
  type VoiceSessionInput,
  type VoiceState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as VoiceSessions from "./VoiceSessions.ts";

export class VoiceSessionService extends Context.Service<
  VoiceSessionService,
  {
    readonly capability: (threadId: ThreadId) => Effect.Effect<VoiceCapability, VoiceError>;
    readonly start: (
      input: VoiceStartInput,
      owner: string,
    ) => Effect.Effect<{ sessionId: string; sdp: string }, VoiceError>;
    readonly stop: (input: VoiceSessionInput, owner: string) => Effect.Effect<void, VoiceError>;
    readonly state: (
      input: VoiceSessionInput,
      owner: string,
    ) => Effect.Effect<VoiceState, VoiceError>;
  }
>()("t3/orchestration-v2/VoiceSessionService") {}
const decodeCodexSettings = Schema.decodeOption(CodexSettings);
const isVoiceError = Schema.is(VoiceError);
const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const sessions = yield* VoiceSessions.VoiceSessions;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const capability = Effect.fn("VoiceSessionService.capability")(function* (threadId: ThreadId) {
    const { thread } = yield* projections
      .getThreadRecords(threadId, [])
      .pipe(Effect.mapError((cause) => new VoiceError({ reason: "unsupported", cause })));
    const instance = yield* providers.getInstance(thread.modelSelection.instanceId);
    if (!instance || !instance.enabled || instance.driverKind !== "codex")
      return {
        available: false,
        reason:
          "Choose a Codex provider for this brainstorming chat. Your other providers remain available for ordinary work.",
      };
    const config = (yield* settings.getSettings.pipe(
      Effect.mapError((cause) => new VoiceError({ reason: "connection", cause })),
    )).providerInstances[instance.instanceId]?.config;
    const codex = decodeCodexSettings(config ?? {});
    if (codex._tag === "None" || codex.value.setupMode === "managed")
      return { available: false, reason: new VoiceError({ reason: "unsupported" }).message };
    return {
      available: true,
      reason:
        "Requires Codex CLI ChatGPT subscription sign-in. Availability is checked when connecting.",
    };
  });
  return VoiceSessionService.of({
    capability,
    start: Effect.fn("VoiceSessionService.start")(function* (input, owner) {
      if (!(yield* capability(input.threadId)).available)
        return yield* new VoiceError({ reason: "unsupported" });
      const { thread, runs } = yield* projections
        .getThreadRecords(input.threadId, ["runs"])
        .pipe(Effect.mapError((cause) => new VoiceError({ reason: "connection", cause })));
      const selected = yield* providers.getInstance(thread.modelSelection.instanceId);
      if (selected?.driverKind !== "codex") return yield* new VoiceError({ reason: "unsupported" });
      if (
        runs.some((run) =>
          ["preparing", "starting", "running", "waiting", "queued"].includes(run.status),
        )
      )
        return yield* new VoiceError({ reason: "busy" });
      const answer = yield* sessions.prepare(input, owner);
      return yield* Effect.gen(function* () {
        yield* threads
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`voice:${input.sessionId}`),
            threadId: input.threadId,
            messageId: MessageId.make(`voice:${input.sessionId}`),
            voiceSessionId: input.sessionId,
            modelSelection: thread.modelSelection,
            text: "Voice brainstorming session",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
          })
          .pipe(Effect.mapError((cause) => new VoiceError({ reason: "connection", cause })));
        const sdp = yield* Deferred.await(answer).pipe(
          Effect.timeout("25 seconds"),
          Effect.mapError((cause) =>
            isVoiceError(cause) ? cause : new VoiceError({ reason: "connection", cause }),
          ),
        );
        return { sessionId: input.sessionId, sdp };
      }).pipe(Effect.onError(() => sessions.stop(input, owner).pipe(Effect.ignore)));
    }),
    stop: sessions.stop,
    state: sessions.state,
  });
});
export const layer = Layer.effect(VoiceSessionService, make);
