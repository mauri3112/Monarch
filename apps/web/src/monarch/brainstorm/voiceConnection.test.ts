import { describe, expect, it, vi } from "vite-plus/test";
import { connectVoice, type VoiceBrowser } from "./voiceConnection";

function setup() {
  const track = { enabled: true, stop: vi.fn() };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  const peer = Object.assign(new EventTarget(), {
    connectionState: "new",
    localDescription: { type: "offer", sdp: "offer" },
    onconnectionstatechange: null as (() => void) | null,
    ontrack: null,
    addTrack: vi.fn(),
    createDataChannel: vi.fn(),
    createOffer: async () => ({ type: "offer", sdp: "offer" }),
    setLocalDescription: async () => {},
    setRemoteDescription: async () => {
      peer.connectionState = "connected";
    },
    close: vi.fn(() => {
      peer.connectionState = "closed";
    }),
  });
  const audio = { autoplay: false, srcObject: null, pause: vi.fn(), play: async () => {} };
  const browser: VoiceBrowser = {
    capture: async () => stream,
    peer: () => peer as unknown as RTCPeerConnection,
    audio: () => audio as unknown as HTMLAudioElement,
  };
  return { track, stream, peer, audio, browser };
}

describe("voice browser resource ownership", () => {
  it("releases capture that resolves after cancellation without opening a peer", async () => {
    const h = setup();
    let resolveCapture!: (stream: MediaStream) => void;
    const captured = new Promise<MediaStream>((resolve) => {
      resolveCapture = resolve;
    });
    const peer = vi.fn(h.browser.peer);
    const abort = new AbortController();
    const result = connectVoice({
      signal: abort.signal,
      browser: { ...h.browser, capture: () => captured, peer },
      negotiate: async () => "answer",
      disconnected: vi.fn(),
    });
    abort.abort();
    resolveCapture(h.stream);
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(h.track.stop).toHaveBeenCalledOnce();
    expect(peer).not.toHaveBeenCalled();
  });
  it("releases the microphone and peer on failed negotiation", async () => {
    const h = setup();
    await expect(
      connectVoice({
        signal: new AbortController().signal,
        browser: h.browser,
        negotiate: async () => {
          throw new Error("subscription unavailable");
        },
        disconnected: vi.fn(),
      }),
    ).rejects.toThrow("subscription unavailable");
    expect(h.track.stop).toHaveBeenCalledOnce();
    expect(h.peer.close).toHaveBeenCalledOnce();
    expect(h.audio.pause).toHaveBeenCalledOnce();
  });
  it("mutes capture locally and closes every resource exactly once", async () => {
    const h = setup();
    const abort = new AbortController();
    const connection = await connectVoice({
      signal: abort.signal,
      browser: h.browser,
      negotiate: async () => "answer",
      disconnected: vi.fn(),
    });
    connection.mute(true);
    expect(h.track.enabled).toBe(false);
    connection.mute(false);
    expect(h.track.enabled).toBe(true);
    abort.abort();
    connection.stop();
    expect(h.track.stop).toHaveBeenCalledOnce();
    expect(h.peer.close).toHaveBeenCalledOnce();
  });
});
