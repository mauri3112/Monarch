import { useAtomValue } from "@effect/atom-react";
import { createVoiceEnvironmentCommands } from "@t3tools/client-runtime/state/voice";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  ThreadId,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MicIcon, MicOffIcon, SquareIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { randomUUID } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { connectionAtomRuntime } from "~/connection/runtime";
import { useProject, useQuietThreadShell } from "~/state/entities";
import { orchestrationEnvironment } from "~/state/orchestration";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  providerInstanceEntriesFor,
  resolveProjectDefaultProviderModelSelection,
} from "~/providerInstances";
import {
  browserVoiceSupport,
  connectVoice,
  voiceBrowser,
  type VoiceConnection,
} from "./voiceConnection";

const voice = createVoiceEnvironmentCommands(connectionAtomRuntime);
function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Voice could not connect. Check your Codex subscription and try again.";
}

export function CodexBrainstormProjectAction({
  projectRef,
}: {
  readonly projectRef: ScopedProjectRef;
}) {
  const navigate = useNavigate();
  const project = useProject(projectRef);
  const config = useAtomValue(serverEnvironment.configValueAtom(projectRef.environmentId));
  const canCreate = useAtomValue(
    orchestrationEnvironment.v2.dispatchCommand.permissionAtom(projectRef.environmentId),
  );
  const dispatch = useAtomCommand(orchestrationEnvironment.v2.dispatchCommand, {
    reportFailure: false,
  });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = config
    ? providerInstanceEntriesFor(config.providers, config.settings, projectRef.projectId).filter(
        (p) => p.driverKind === "codex" && p.enabled,
      )
    : [];
  const model = config
    ? resolveProjectDefaultProviderModelSelection(
        config.providers.filter((p) => candidates.some((c) => c.instanceId === p.instanceId)),
        config.settings,
        projectRef.projectId,
      )
    : null;
  const create = async () => {
    if (!model || !project || creating) return;
    setCreating(true);
    setError(null);
    const threadId = ThreadId.make(randomUUID());
    const result = await dispatch({
      environmentId: projectRef.environmentId,
      input: {
        type: "thread.create",
        commandId: CommandId.make(randomUUID()),
        threadId,
        projectId: projectRef.projectId,
        title: "Brainstorm with Codex",
        modelSelection: model,
        runtimeMode: "approval-required",
        interactionMode: "plan",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      },
    });
    setCreating(false);
    if (result._tag === "Failure") {
      setError(errorMessage(squashAtomCommandFailure(result)));
      return;
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: projectRef.environmentId, threadId },
    });
  };
  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="outline"
        size="sm"
        disabled={!canCreate || !model || creating}
        onClick={() => void create()}
      >
        <MicIcon />
        {creating ? "Opening…" : "Brainstorm with Codex"}
      </Button>
      {!model && (
        <span className="text-xs text-muted-foreground">
          Connect Codex with your ChatGPT subscription in provider settings.
        </span>
      )}
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}

export function CodexBrainstormThreadAction({
  threadRef,
}: {
  readonly threadRef: ScopedThreadRef;
}) {
  return (
    <BrainstormControl
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
    />
  );
}
function BrainstormControl({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const shell = useQuietThreadShell(threadRef);
  const config = useAtomValue(serverEnvironment.configValueAtom(threadRef.environmentId));
  const canStart = useAtomValue(voice.start.permissionAtom(threadRef.environmentId));
  const [status, setStatus] = useState<"idle" | "connecting" | "connected">("idle");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const active = useRef<{
    abort: AbortController;
    connection: VoiceConnection | undefined;
    cleanup: () => void;
  } | null>(null);
  const startRpc = useAtomCommand(voice.start, { reportFailure: false });
  const stopRpc = useAtomCommand(voice.stop, { reportFailure: false });
  const checkRpc = useAtomCommand(voice.state, { reportFailure: false });
  const capabilityRpc = useAtomCommand(voice.capability, { reportFailure: false });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Stop device capture and the owned server session when this thread control unmounts.
  useEffect(() => () => active.current?.cleanup(), []);
  const provider = config?.providers.find((p) => p.instanceId === shell?.modelSelection.instanceId);
  if (provider?.driver !== "codex" && status === "idle") return null;
  const end = () => {
    active.current?.cleanup();
    active.current = null;
    setStatus("idle");
    setMuted(false);
  };
  const start = async () => {
    if (active.current) return;
    setError(null);
    const unsupported = browserVoiceSupport();
    if (unsupported) {
      setError(unsupported);
      return;
    }
    const sessionId = randomUUID();
    const target = {
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, sessionId },
    };
    const abort = new AbortController();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    const current = {
      abort,
      connection: undefined as VoiceConnection | undefined,
      cleanup: () => {
        if (stopped) return;
        stopped = true;
        abort.abort();
        current.connection?.stop();
        clearInterval(heartbeat);
        void stopRpc(target);
      },
    };
    active.current = current;
    setStatus("connecting");
    try {
      const capability = await capabilityRpc({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
      if (stopped) return;
      if (capability._tag === "Failure") {
        end();
        setError(errorMessage(squashAtomCommandFailure(capability)));
        return;
      }
      if (!capability.value.available) {
        end();
        setError(capability.value.reason);
        return;
      }
      const checkStatus = () => {
        void checkRpc(target).then((result) => {
          if (stopped) return;
          if (
            result._tag === "Failure" ||
            result.value.status === "closed" ||
            result.value.status === "error"
          ) {
            end();
            setError(
              result._tag === "Failure"
                ? errorMessage(squashAtomCommandFailure(result))
                : result.value.reason || "Voice ended.",
            );
          }
        });
      };
      current.connection = await connectVoice({
        signal: abort.signal,
        browser: voiceBrowser,
        negotiate: async (sdp) => {
          const result = await startRpc({ ...target, input: { ...target.input, sdp } });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          if (stopped) throw new DOMException("Voice stopped", "AbortError");
          heartbeat = setInterval(checkStatus, 5_000);
          return result.value.sdp;
        },
        disconnected: (message) => {
          if (stopped) return;
          end();
          setError(message);
        },
      });
      if (stopped) {
        current.connection.stop();
        return;
      }
      setStatus("connected");
    } catch (cause) {
      if (!stopped) {
        end();
        setError(errorMessage(cause));
      }
    }
  };
  return (
    <div className="flex max-w-md flex-col gap-1">
      <div className="flex items-center gap-2">
        {status === "idle" ? (
          <Button size="sm" variant="outline" disabled={!canStart} onClick={() => void start()}>
            <MicIcon />
            Start voice
          </Button>
        ) : (
          <>
            <Button size="sm" variant="outline" onClick={end}>
              <SquareIcon />
              {status === "connecting" ? "Cancel voice" : "End voice"}
            </Button>
            {status === "connected" && (
              <Button
                size="sm"
                variant="ghost"
                aria-label={muted ? "Unmute microphone" : "Mute microphone"}
                onClick={() => {
                  active.current?.connection?.mute(!muted);
                  setMuted(!muted);
                }}
              >
                {muted ? <MicOffIcon /> : <MicIcon />}
              </Button>
            )}
            <span role="status" className="text-xs text-muted-foreground">
              {status === "connecting"
                ? "Connecting…"
                : muted
                  ? "Microphone muted"
                  : "Microphone on"}
            </span>
          </>
        )}
      </div>
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
      {status === "idle" && !error && shell?.title === "Brainstorm with Codex" && (
        <span className="text-xs text-muted-foreground">
          Voice uses your Codex subscription. Start voice to allow microphone access.
        </span>
      )}
    </div>
  );
}
