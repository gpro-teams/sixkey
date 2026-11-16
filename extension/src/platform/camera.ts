// The camera on Settings > Add account (docs/design/notes/IMPORT-FILE-NOTES.md §4). getUserMedia in the settings tab:
// Chrome asks once for the extension's own origin and needs no manifest permission; the toolbar popup gets no prompt
// at all, so the camera is offered on the settings page only. Frames are read one at a time, a few per second, each
// decoded in memory and dropped: nothing is recorded, stored or sent. Every way out stops every track of the stream:
// a code found, Cancel, an error, the tab hidden, the page left, the component gone (Sixkey locked from any page: the
// settings page's own lock watch, App.tsx, then shows it locked and the camera's component stops it), and a stream that
// arrives after any of those (a generation number tells a late stream from the current one).

export type TrackLike = { stop(): void };
export type StreamLike = { getTracks(): TrackLike[] };

/** "denied": the user, the browser, the system or a policy refused the camera; "failed": none, busy, or broken. */
export type CameraError = "denied" | "failed";

export type CameraDeps = {
  getUserMedia(c: MediaStreamConstraints): Promise<StreamLike>;
  /** Shows the stream in the page's preview (its srcObject), or, with null, takes it away. */
  show(stream: StreamLike | null): Promise<void> | void;
  /** The QR codes in the frame on screen now; null when there is no frame yet. One call at a time. */
  grab(): Promise<string[] | null>;
  wait(ms: number): Promise<void>;
};

/** About seven frames a second at most, and never a new one before the last is decoded: the CPU stays low. */
export const FRAME_GAP_MS = 140;

export const CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
};

/** What a getUserMedia failure means for the user: refused (by them, the system or a policy), or no usable camera. */
export function cameraError(e: unknown): CameraError {
  const name = (e as { name?: unknown } | null)?.name;
  return name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError"
    ? "denied"
    : "failed";
}

function stopAll(s: StreamLike | null): void {
  if (!s) return;
  for (const t of s.getTracks()) {
    try {
      t.stop();
    } catch {
      /* already stopped */
    }
  }
}

export type CameraEvents = {
  /** Codes read from a frame; return true when the scan is over (the camera then stops). */
  onCodes(texts: string[]): boolean;
  onError(e: CameraError): void;
  onLive(live: boolean): void;
};

export class CameraScan {
  private gen = 0;
  private stream: StreamLike | null = null;
  constructor(
    private readonly deps: CameraDeps,
    private readonly ev: CameraEvents,
  ) {}

  /** Whether a stream is open now (for tests and the page's state). */
  get open(): boolean {
    return this.stream !== null;
  }

  /** Opens the camera and reads frames until a scan is over or stop() is called. Never throws. */
  async start(): Promise<void> {
    this.stop();
    const gen = this.gen;
    let s: StreamLike;
    try {
      s = await this.deps.getUserMedia(CONSTRAINTS);
    } catch (e) {
      if (gen === this.gen) this.ev.onError(cameraError(e));
      return;
    }
    if (gen !== this.gen) return stopAll(s); // stopped while Chrome was asking: this late stream is closed at once
    this.stream = s;
    try {
      await this.deps.show(s);
    } catch {
      if (gen === this.gen) {
        this.stop();
        this.ev.onError("failed");
      }
      return;
    }
    if (gen !== this.gen) return;
    this.ev.onLive(true);
    while (gen === this.gen) {
      await this.deps.wait(FRAME_GAP_MS);
      if (gen !== this.gen) return;
      let texts: string[] | null = null;
      try {
        texts = await this.deps.grab();
      } catch {
        texts = null; // a frame that could not be read: the next one is tried
      }
      if (gen !== this.gen) return;
      if (texts?.length && this.ev.onCodes(texts)) return this.stop();
    }
  }

  /** Stops every track and the frame loop; a stream still on its way is stopped when it arrives. Idempotent. */
  stop(): void {
    this.gen++;
    const s = this.stream;
    this.stream = null;
    stopAll(s);
    if (s) {
      try {
        void Promise.resolve(this.deps.show(null)).catch(() => undefined);
      } catch {
        /* the preview is gone already */
      }
      this.ev.onLive(false);
    }
  }
}

type Listening = {
  addEventListener(type: string, f: () => void): void;
  removeEventListener(type: string, f: () => void): void;
};
/**
 * Calls `stop` when the camera must go off while the page stays: the tab is hidden (at once: nobody sees the preview),
 * or the page is left. A lock is the page's own business: the settings page already watches the lock epoch (App.tsx),
 * shows itself locked, and the camera's component stops it then (AddCamera.tsx `enabled`). Returns the function that
 * stops listening.
 */
export function stopWhenAway(
  stop: () => void,
  env: { doc?: Listening & { visibilityState: string }; win?: Listening },
): () => void {
  const hidden = () => {
    if (env.doc?.visibilityState === "hidden") stop();
  };
  env.doc?.addEventListener("visibilitychange", hidden);
  env.win?.addEventListener("pagehide", stop);
  return () => {
    env.doc?.removeEventListener("visibilitychange", hidden);
    env.win?.removeEventListener("pagehide", stop);
  };
}
