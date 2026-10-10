// @vitest-environment happy-dom
// The client-side caption state (web/shared/state.ts) and the URL parameters of the caption page
// and the overlay (params.ts).
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../../src/shared/protocol.js";
import {
  parseDisplayParams,
  parseOverlayParams,
  parsePageParams,
} from "../../web/shared/params.js";
import { CaptionState } from "../../web/shared/state.js";
import { segment, status, text } from "./helpers/web-shared-fakes.js";

const q = (s: string) => new URLSearchParams(s);

describe("caption state", () => {
  it("takes the primary track, languages and clock skew from hello", () => {
    const s = new CaptionState();
    const change = s.apply({
      type: "hello",
      protocol: 1,
      serverTime: Date.now() + 5000,
      sessionId: "s1",
      langs: { source: "ar", targets: ["nl"] },
      tracks: ["soniox"],
      primary: "soniox",
    });
    expect(change).toEqual({ kind: "hello" });
    expect(s.primary).toBe("soniox");
    expect(s.langs).toEqual({ source: "ar", targets: ["nl"] });
    expect(s.serverSkewMs).toBeGreaterThan(4000);
    expect(s.serverSkewMs).toBeLessThanOrEqual(5000);
  });

  it("replaces a track's segments, session and status with a snapshot", () => {
    const s = new CaptionState();
    s.upsert(segment(9, text("old")));
    const session = {
      id: "s1",
      kind: "page" as const,
      startedAt: 1,
      from: "ar",
      to: "nl",
      source: "page" as const,
      inputKind: "page" as const,
    };
    const st = status({ state: "live" });
    const change = s.apply({
      type: "snapshot",
      track: "soniox",
      session,
      segments: [segment(2, text("b")), segment(1, text("a"))],
      status: st,
    });
    expect(change).toEqual({ kind: "snapshot", track: "soniox" });
    expect(s.segments("soniox").map((x) => x.seq)).toEqual([1, 2]);
    expect(s.session).toBe(session);
    expect(s.status).toBe(st);
    expect(s.primary).toBe("soniox");
  });

  it("upserts segments by id and keeps display order across sessions", () => {
    const s = new CaptionState();
    expect(s.segments("soniox")).toEqual([]);
    expect(
      s.apply({
        type: "segment",
        track: "soniox",
        segment: segment(5, text("x"), {}, { session: "a" }),
      }),
    ).toEqual({
      kind: "segments",
      track: "soniox",
    });
    s.upsert(segment(1, text("y"), {}, { session: "b" }));
    s.upsert(segment(2, text("z"), {}, { session: "a" }));
    s.upsert(segment(5, text("x2"), {}, { session: "a" }));
    expect(s.segments("soniox").map((x) => `${x.sessionId}${x.seq}:${x.source.text}`)).toEqual([
      "a2:z",
      "a5:x2",
      "b1:y",
    ]);
    expect(s.trackIds()).toEqual(["soniox"]);
  });

  it("clears one track or all", () => {
    const s = new CaptionState();
    s.upsert(segment(1, text("a")));
    expect(s.apply({ type: "clear", track: "soniox" })).toEqual({ kind: "clear", track: "soniox" });
    expect(s.segments("soniox")).toEqual([]);
    expect(s.trackIds()).toEqual([]);
    s.upsert(segment(2, text("b")));
    expect(s.apply({ type: "clear", track: "all" })).toEqual({ kind: "clear", track: "all" });
    expect(s.trackIds()).toEqual([]);
  });

  it("takes the status, and its session only when it has one", () => {
    const s = new CaptionState();
    const session = {
      id: "s9",
      kind: "device" as const,
      startedAt: 5,
      from: "ar",
      to: "nl",
      source: "device" as const,
      inputKind: "device" as const,
    };
    expect(s.apply({ type: "status", status: status({ session }) })).toEqual({ kind: "status" });
    expect(s.session).toBe(session);
    const bare = status({ state: "idle" });
    s.apply({ type: "status", status: bare });
    expect(s.status).toBe(bare);
    expect(s.session).toBe(session);
  });

  it("ignores messages that are not about captions", () => {
    const s = new CaptionState();
    const level: ServerMessage = { type: "level", rmsDbfs: -20, peakDbfs: -10 };
    expect(s.apply(level)).toEqual({ kind: "none" });
    expect(s.apply({ type: "mode", mode: "athan" })).toEqual({ kind: "none" });
  });

  it("keeps at most 80 segments per track, dropping the oldest", () => {
    const s = new CaptionState();
    for (let i = 1; i <= 85; i++) s.upsert(segment(i, text(`t${i}`)));
    const seqs = s.segments("soniox").map((x) => x.seq);
    expect(seqs).toHaveLength(80);
    expect(seqs[0]).toBe(6);
    expect(seqs.at(-1)).toBe(85);
    s.replace(
      "soniox",
      Array.from({ length: 90 }, (_, i) => segment(i + 1, text("r"))),
    );
    expect(s.segments("soniox").map((x) => x.seq)[0]).toBe(11);
  });
});

describe("display parameters", () => {
  it("has calm defaults", () => {
    expect(parseDisplayParams(q(""))).toEqual({
      lines: 2,
      size: 46,
      srcScale: null,
      lineHeight: null,
      pos: "bottom",
      width: 90,
      bg: "band",
      partial: true,
      idle: 10,
      debug: false,
    });
  });

  it("reads and clamps numbers, and falls back on garbage", () => {
    const p = parseDisplayParams(q("lines=3.6&size=999&width=5&srcScale=9&idle=0&debug=yes"));
    expect(p.lines).toBe(4);
    expect(p.size).toBe(300);
    expect(p.width).toBe(10);
    expect(p.srcScale).toBe(4);
    expect(p.idle).toBe(0);
    expect(p.debug).toBe(true);
    const bad = parseDisplayParams(q("lines=abc&size=%20&srcScale=x&idle=&lines=7"));
    expect(bad.lines).toBe(2);
    expect(bad.size).toBe(46);
    expect(bad.srcScale).toBeNull();
    expect(bad.idle).toBe(10);
    expect(parseDisplayParams(q("lines=-3&size=1&idle=999999")).lines).toBe(1);
    expect(parseDisplayParams(q("idle=999999")).idle).toBe(86_400);
  });

  it("accepts the older arScale for the source scale", () => {
    expect(parseDisplayParams(q("arScale=1.4")).srcScale).toBe(1.4);
    expect(parseDisplayParams(q("arScale=0.1")).srcScale).toBe(0.3);
    expect(parseDisplayParams(q("srcScale=1.2&arScale=2")).srcScale).toBe(1.2);
  });

  it("reads choices case-insensitively and ignores unknown ones", () => {
    const p = parseDisplayParams(q("pos=TOP&bg=%20shadow%20"));
    expect(p.pos).toBe("top");
    expect(p.bg).toBe("shadow");
    expect(parseDisplayParams(q("pos=left&bg=striped")).pos).toBe("bottom");
    expect(parseDisplayParams(q("pos=middle&bg=none")).bg).toBe("none");
  });

  it("reads switches in every usual spelling", () => {
    for (const v of ["1", "true", "yes", "on", " ON "]) {
      expect(parseDisplayParams(q(`partial=0&debug=${encodeURIComponent(v)}`)).debug, v).toBe(true);
    }
    for (const v of ["0", "false", "no", "off"]) {
      expect(parseDisplayParams(q(`partial=${v}`)).partial, v).toBe(false);
    }
    expect(parseDisplayParams(q("partial=maybe")).partial).toBe(true);
    expect(parseDisplayParams(q("partial=")).partial).toBe(true);
  });
});

describe("caption page parameters", () => {
  it("adds the microphone, channel, DSP, key and status bar choices", () => {
    const p = parsePageParams(q("mic=%20USB%20&ch=LEFT&dsp=1&key=%20abc%20&show=source"), false);
    expect(p.mic).toBe("USB");
    expect(p.ch).toBe("left");
    expect(p.dsp).toBe(true);
    expect(p.key).toBe("abc");
    expect(p.show).toBe("source");
    expect(p.ui).toBe(true);
    expect(p.nativeRate).toBe(false);
    const d = parsePageParams(q("mic=&key=%20"), false);
    expect(d.mic).toBeNull();
    expect(d.key).toBeNull();
    expect(d.ch).toBe("mix");
    expect(d.show).toBe("both");
    expect(d.dsp).toBe(false);
  });

  it("hides the status bar inside OBS unless ui= says otherwise", () => {
    expect(parsePageParams(q(""), true).ui).toBe(false);
    expect(parsePageParams(q("ui=auto"), false).ui).toBe(true);
    expect(parsePageParams(q("ui=1"), true).ui).toBe(true);
    expect(parsePageParams(q("ui=TRUE"), true).ui).toBe(true);
    expect(parsePageParams(q("ui=0"), false).ui).toBe(false);
    expect(parsePageParams(q("ui=false"), false).ui).toBe(false);
  });

  it("skips the 16 kHz context only with rate=native", () => {
    expect(parsePageParams(q("rate=%20Native"), false).nativeRate).toBe(true);
    expect(parsePageParams(q("rate=16000"), false).nativeRate).toBe(false);
  });

  it("ignores the removed engine choice of older links", () => {
    const withEngine = parsePageParams(q("engine=gemini&translation=gemini&lines=3"), false);
    const without = parsePageParams(q("lines=3"), false);
    expect(withEngine).toEqual(without);
    expect(Object.keys(withEngine)).not.toContain("engine");
  });
});

describe("overlay parameters", () => {
  it("shows Arabic and Dutch by default", () => {
    const p = parseOverlayParams(q(""));
    expect(p.langs).toEqual(["ar", "nl"]);
    expect(p.session).toBeNull();
    expect(p.token).toBeNull();
  });

  it("reads the language list, the session and the token", () => {
    const p = parseOverlayParams(q("lang=%20nl%20,,en&session=abc&token=t0k&track=gemini"));
    expect(p.langs).toEqual(["nl", "en"]);
    expect(p.session).toBe("abc");
    expect(p.token).toBe("t0k");
    expect(Object.keys(p)).not.toContain("track");
    expect(parseOverlayParams(q("lang=,%20,")).langs).toEqual(["ar", "nl"]);
  });
});
