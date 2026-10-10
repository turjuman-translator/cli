// Screen pages on /ws/page: which sockets use which signed screen link, so that
// enable / disable / reset / regenerate / delete in the admin portal reach every page of a
// screen, and the portal can show each screen's live state.
import type { CaptionSessionApi } from "../core/contracts.js";
import type { ScreenView } from "../shared/protocol.js";

export type ScreenLive = ScreenView["live"];

/** One /ws/page socket that said hello with a valid link of a screen. */
export interface ScreenConn {
  readonly connectedAt: number;
  /** The session this socket feeds (null while parked or handshaking). */
  readonly session: CaptionSessionApi | null;
  /** Parked socket: send {screen enabled} (the page answers with a new hello); false if not parked. */
  notifyEnabled(name: string): boolean;
  /** Live socket of a screen being disabled: keep it open while its session stops. */
  beginPark(): void;
  /** Its session has stopped: send {screen disabled} and park the socket. */
  park(name: string): void;
  /** The link was regenerated or deleted: error screen_invalid + close. */
  invalidate(): void;
  /** The look changed: send {screen reload}; false if the socket is gone. */
  reload(): boolean;
}

export class ScreenHub {
  private readonly byScreen = new Map<string, Set<ScreenConn>>();

  add(screenId: string, conn: ScreenConn): void {
    let set = this.byScreen.get(screenId);
    if (set === undefined) {
      set = new Set();
      this.byScreen.set(screenId, set);
    }
    set.add(conn);
  }

  remove(screenId: string, conn: ScreenConn): void {
    const set = this.byScreen.get(screenId);
    if (set === undefined) return;
    set.delete(conn);
    if (set.size === 0) this.byScreen.delete(screenId);
  }

  list(screenId: string): ScreenConn[] {
    return [...(this.byScreen.get(screenId) ?? [])];
  }

  clear(): void {
    this.byScreen.clear();
  }
}
