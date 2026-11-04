import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/** Retains the legacy IPC contract without importing another app's browser profile. */
export class DesktopLegacyLocalStorage extends Context.Service<
  DesktopLegacyLocalStorage,
  {
    readonly load: (userDataPath: string) => Effect.Effect<void>;
    readonly take: Effect.Effect<Option.Option<Readonly<Record<string, string>>>>;
    readonly complete: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopLegacyLocalStorage") {}

// Monarch never imports credentials, remote connections or drafts from a T3 browser profile.
export const layer = Layer.succeed(DesktopLegacyLocalStorage, {
  load: Effect.fn("DesktopLegacyLocalStorage.load")((_userDataPath: string) => Effect.void),
  take: Effect.succeed(Option.none<Readonly<Record<string, string>>>()),
  complete: Effect.void,
});
