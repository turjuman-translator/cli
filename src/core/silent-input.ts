import type { AudioState } from "../shared/protocol.js";
import type { AudioInputApi, AudioInputHandlers } from "./contracts.js";

const FRAME_BYTES = 3200;
const FRAME_MS = 100;

/**
 * An audio input that emits digital silence in real time. `turjuman replay` uses it so a local
 * session runs without hardware while a FakeProvider replays recorded captions.
 */
export class SilentAudioInput implements AudioInputApi {
  private timer: NodeJS.Timeout | null = null;
  private current: AudioState = "idle";

  get state(): AudioState {
    return this.current;
  }

  get lastStderr(): string | null {
    return null;
  }

  start(handlers: AudioInputHandlers): void {
    if (this.timer !== null) return;
    const frame = new Uint8Array(FRAME_BYTES);
    this.current = "ok";
    handlers.onState?.("ok", { lastStderr: null });
    this.timer = setInterval(() => {
      handlers.onFrame(frame.slice(), Date.now());
      handlers.onLevel?.({ rmsDbfs: -100, peakDbfs: -100 });
    }, FRAME_MS);
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.current = "idle";
  }
}
