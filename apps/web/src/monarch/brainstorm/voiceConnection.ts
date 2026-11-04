export interface VoiceBrowser {
  readonly capture: () => Promise<MediaStream>;
  readonly peer: () => RTCPeerConnection;
  readonly audio: () => HTMLAudioElement;
}
export interface VoiceConnection {
  readonly stop: () => void;
  readonly mute: (muted: boolean) => void;
}

export async function connectVoice(input: {
  readonly signal: AbortSignal;
  readonly browser: VoiceBrowser;
  readonly negotiate: (offer: string) => Promise<string>;
  readonly disconnected: (message: string) => void;
}): Promise<VoiceConnection> {
  let capture: MediaStream | undefined;
  let peer: RTCPeerConnection | undefined;
  let audio: HTMLAudioElement | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    input.signal.removeEventListener("abort", stop);
    capture?.getTracks().forEach((track) => track.stop());
    if (peer) {
      peer.onconnectionstatechange = null;
      peer.ontrack = null;
      peer.close();
    }
    if (audio) {
      audio.pause();
      audio.srcObject = null;
    }
  };
  const check = () => {
    if (stopped || input.signal.aborted) throw new DOMException("Voice stopped", "AbortError");
  };
  input.signal.addEventListener("abort", stop, { once: true });
  try {
    check();
    capture = await input.browser.capture();
    if (stopped || input.signal.aborted) {
      capture.getTracks().forEach((track) => track.stop());
      check();
    }
    peer = input.browser.peer();
    audio = input.browser.audio();
    audio.autoplay = true;
    peer.ontrack = (event) => {
      if (stopped || !audio) return;
      audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void audio.play().catch(() => {
        stop();
        input.disconnected("Allow audio playback, then start voice again.");
      });
    };
    peer.onconnectionstatechange = () => {
      if (
        peer?.connectionState === "failed" ||
        peer?.connectionState === "disconnected" ||
        peer?.connectionState === "closed"
      ) {
        stop();
        input.disconnected("Voice connection ended. Start again to reconnect.");
      }
    };
    for (const track of capture.getAudioTracks()) peer.addTrack(track, capture);
    peer.createDataChannel("oai-events");
    const offer = await peer.createOffer();
    check();
    await peer.setLocalDescription(offer);
    check();
    const sdp = peer.localDescription?.sdp;
    if (!sdp) throw new Error("The browser could not prepare a voice connection.");
    const answer = await input.negotiate(sdp);
    check();
    await peer.setRemoteDescription({ type: "answer", sdp: answer });
    check();
    const connectedPeer = peer;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        connectedPeer.removeEventListener("connectionstatechange", changed);
        input.signal.removeEventListener("abort", aborted);
        if (error) reject(error);
        else resolve();
      };
      const changed = () => {
        if (connectedPeer.connectionState === "connected") finish();
        else if (["failed", "disconnected", "closed"].includes(connectedPeer.connectionState))
          finish(new Error("Voice could not establish an audio connection."));
      };
      const aborted = () => finish(new DOMException("Voice stopped", "AbortError"));
      const timeout = setTimeout(
        () => finish(new Error("Voice could not establish an audio connection. Please retry.")),
        15_000,
      );
      connectedPeer.addEventListener("connectionstatechange", changed);
      input.signal.addEventListener("abort", aborted, { once: true });
      changed();
    });
    check();
    return {
      stop,
      mute: (muted) =>
        capture?.getAudioTracks().forEach((track) => {
          track.enabled = !muted;
        }),
    };
  } catch (error) {
    stop();
    throw error;
  }
}

export function browserVoiceSupport(): string | null {
  if (!globalThis.isSecureContext) return "Microphone access needs HTTPS or localhost.";
  if (!globalThis.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia)
    return "This client does not support browser voice. Use Monarch in a desktop browser.";
  return null;
}
export const voiceBrowser: VoiceBrowser = {
  capture: () =>
    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    }),
  peer: () => new RTCPeerConnection(),
  audio: () => new Audio(),
};
