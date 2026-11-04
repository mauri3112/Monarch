import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const VoiceSessionId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export const VoiceTarget = Schema.Struct({ threadId: ThreadId });
export const VoiceStartInput = Schema.Struct({
  threadId: ThreadId,
  sessionId: VoiceSessionId,
  sdp: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536)),
});
export type VoiceStartInput = typeof VoiceStartInput.Type;
export const VoiceSessionInput = Schema.Struct({ threadId: ThreadId, sessionId: VoiceSessionId });
export type VoiceSessionInput = typeof VoiceSessionInput.Type;
export const VoiceCapability = Schema.Struct({ available: Schema.Boolean, reason: Schema.String });
export type VoiceCapability = typeof VoiceCapability.Type;
export const VoiceStartResult = Schema.Struct({ sessionId: VoiceSessionId, sdp: Schema.String });
export const VoiceState = Schema.Struct({
  sessionId: VoiceSessionId,
  status: Schema.Literals(["starting", "connected", "stopping", "closed", "error"]),
  reason: Schema.String,
});
export type VoiceState = typeof VoiceState.Type;
export class VoiceError extends Schema.TaggedError<VoiceError>()("VoiceError", {
  reason: Schema.Literals([
    "unsupported",
    "subscription",
    "busy",
    "owner",
    "expired",
    "connection",
    "cancelled",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported":
        return "Voice needs a Codex CLI signed in with ChatGPT in this environment. Managed-token voice is not supported yet.";
      case "subscription":
        return "Sign in to the Codex CLI with your ChatGPT subscription to use voice.";
      case "busy":
        return "Finish the current work or voice session before starting another voice session.";
      case "owner":
        return "This voice session belongs to another signed-in session.";
      case "expired":
        return "This voice session has ended. Start a new session.";
      case "cancelled":
        return "Voice was stopped.";
      case "connection":
        return "Codex voice could not connect. Check your subscription availability and retry. No API-key fallback was used.";
    }
  }
}
