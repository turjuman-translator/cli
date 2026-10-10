// @vitest-environment happy-dom
// The small DOM helpers every page uses (web/shared/dom.ts), the readable banners of the caption
// page (banners.ts) and the honorific ligature spans (hon.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Banners } from "../../web/shared/banners.js";
import {
  byId,
  el,
  fmtDuration,
  fmtMs,
  isLocalHost,
  setStyle,
  storageGet,
  storageSet,
  wsUrl,
} from "../../web/shared/dom.js";
import { honNodes, setHonText } from "../../web/shared/hon.js";
import { setUrl } from "./helpers/web-shared-fakes.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
  localStorage.clear();
});

describe("el and byId", () => {
  it("builds an element with a class, text, attributes and children", () => {
    const child = el("b", { text: "bold" });
    const node = el("p", { class: "note", attrs: { title: "hint", "data-x": "1" } }, [
      "plain ",
      child,
    ]);
    expect(node.tagName).toBe("P");
    expect(node.className).toBe("note");
    expect(node.getAttribute("title")).toBe("hint");
    expect(node.dataset.x).toBe("1");
    expect(node.textContent).toBe("plain bold");
    expect(node.lastChild).toBe(child);
  });

  it("leaves out what is not given (an empty text is still set)", () => {
    const bare = el("span");
    expect(bare.className).toBe("");
    expect(bare.attributes.length).toBe(0);
    expect(el("span", { text: "" }).textContent).toBe("");
  });

  it("finds an element of the right type by id, and throws when the template is out of sync", () => {
    document.body.append(el("div", { attrs: { id: "box" } }), el("span", { attrs: { id: "s" } }));
    expect(byId("box", HTMLDivElement).id).toBe("box");
    expect(() => byId("nothing", HTMLDivElement)).toThrow(
      "#nothing missing or not a HTMLDivElement",
    );
    expect(() => byId("s", HTMLDivElement)).toThrow("#s missing or not a HTMLDivElement");
  });
});

describe("storage", () => {
  it("remembers, reads and forgets values", () => {
    expect(storageGet("k")).toBeNull();
    storageSet("k", "v");
    expect(storageGet("k")).toBe("v");
    expect(localStorage.getItem("k")).toBe("v");
    storageSet("k", null);
    expect(storageGet("k")).toBeNull();
  });

  it("keeps working when storage throws (OBS, privacy modes)", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    vi.stubGlobal("localStorage", broken);
    expect(storageGet("k")).toBeNull();
    expect(() => storageSet("k", "v")).not.toThrow();
    expect(() => storageSet("k", null)).not.toThrow();
  });
});

describe("addresses", () => {
  it("builds ws:// on http and wss:// on https for this host", () => {
    setUrl("http://192.168.1.20:8765/ar/nl");
    expect(wsUrl("/ws/page")).toBe("ws://192.168.1.20:8765/ws/page");
    setUrl("https://captions.example.org/overlay");
    expect(wsUrl("/ws?session=a")).toBe("wss://captions.example.org/ws?session=a");
  });

  it("knows the loopback names, whatever their case", () => {
    for (const h of ["localhost", "LOCALHOST", "127.0.0.1", "[::1]", "::1"]) {
      expect(isLocalHost(h), h).toBe(true);
    }
    expect(isLocalHost("192.168.1.5")).toBe(false);
    expect(isLocalHost("example.org")).toBe(false);
    setUrl("http://localhost:8765/");
    expect(isLocalHost()).toBe(true);
    setUrl("http://mosque.local:8765/");
    expect(isLocalHost()).toBe(false);
  });
});

describe("formatting", () => {
  it("writes durations as m:ss or h:mm:ss", () => {
    expect(fmtDuration(0)).toBe("0:00");
    expect(fmtDuration(-5000)).toBe("0:00");
    expect(fmtDuration(123_456)).toBe("2:03");
    expect(fmtDuration(3_723_000)).toBe("1:02:03");
  });

  it("writes milliseconds as seconds, or a dash without a value", () => {
    expect(fmtMs(1240)).toBe("1.24 s");
    expect(fmtMs(0)).toBe("0.00 s");
    expect(fmtMs(null)).toBe("–");
    expect(fmtMs(undefined)).toBe("–");
    expect(fmtMs(Number.NaN)).toBe("–");
    expect(fmtMs(Number.POSITIVE_INFINITY)).toBe("–");
  });

  it("sets and removes style properties through the CSSOM", () => {
    const node = el("div");
    setStyle(node, "--cap-x", "4px");
    setStyle(node, "width", "50%");
    expect(node.style.getPropertyValue("--cap-x")).toBe("4px");
    expect(node.style.width).toBe("50%");
    setStyle(node, "width", null);
    expect(node.style.width).toBe("");
    expect(node.getAttribute("style")).not.toContain("width");
  });
});

describe("banners", () => {
  let host: HTMLDivElement;
  let banners: Banners;

  beforeEach(() => {
    host = el("div");
    document.body.append(host);
    banners = new Banners(host);
  });

  it("shows a banner of a kind and keeps the same node for the same message", () => {
    banners.set("mic", "error", "Microphone not found.");
    const node = host.firstElementChild;
    expect(node?.className).toBe("banner error");
    expect(node?.textContent).toBe("Microphone not found.");
    expect(banners.has("mic")).toBe(true);
    banners.set("mic", "error", "Microphone not found.");
    expect(host.children).toHaveLength(1);
    expect(host.firstElementChild).toBe(node);
  });

  it("replaces a banner whose text or kind changes", () => {
    banners.set("ws", "warn", "Busy.");
    const first = host.firstElementChild;
    banners.set("ws", "error", "Busy.");
    expect(host.children).toHaveLength(1);
    expect(host.firstElementChild).not.toBe(first);
    expect(host.firstElementChild?.className).toBe("banner error");
    banners.set("ws", "error", "Gone.");
    expect(host.textContent).toBe("Gone.");
  });

  it("keeps several banners side by side and clears one by key", () => {
    banners.set("a", "info", "One");
    banners.set("b", "warn", "Two");
    expect([...host.children].map((n) => n.textContent)).toEqual(["One", "Two"]);
    banners.clear("a");
    expect(banners.has("a")).toBe(false);
    expect(host.textContent).toBe("Two");
    banners.clear("nothing");
    expect(host.children).toHaveLength(1);
  });

  it("offers a link action", () => {
    banners.set("path", "error", "Not a caption page.", {
      action: { label: "Choose languages", href: "/app/new" },
    });
    const a = host.querySelector("a");
    expect(a?.textContent).toBe("Choose languages");
    expect(a?.getAttribute("href")).toBe("/app/new");
    expect(host.firstElementChild?.textContent).toBe("Not a caption page. Choose languages");
  });

  it("offers a button action that runs on click", () => {
    const onClick = vi.fn();
    banners.set("mic", "info", "Audio is paused.", { action: { label: "Start audio", onClick } });
    const btn = host.querySelector("button");
    expect(btn?.textContent).toBe("Start audio");
    expect(btn?.type).toBe("button");
    btn?.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("shows only the text for an action with neither a link nor a handler", () => {
    banners.set("x", "info", "Plain.", { action: { label: "Nothing" } });
    expect(host.querySelector("a, button")).toBeNull();
    expect(host.textContent).toBe("Plain.");
  });

  it("changing only the action label makes a new banner", () => {
    banners.set("x", "info", "Text", { action: { label: "One", href: "/1" } });
    banners.set("x", "info", "Text", { action: { label: "Two", href: "/2" } });
    expect(host.querySelectorAll("a")).toHaveLength(1);
    expect(host.querySelector("a")?.textContent).toBe("Two");
  });

  it("hides a banner after its time to live, unless it is set again without one", () => {
    vi.useFakeTimers();
    banners.set("warn", "warn", "Heads up", { ttlMs: 1000 });
    vi.advanceTimersByTime(999);
    expect(banners.has("warn")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(banners.has("warn")).toBe(false);
    expect(host.children).toHaveLength(0);

    banners.set("warn", "warn", "Heads up", { ttlMs: 1000 });
    vi.advanceTimersByTime(500);
    banners.set("warn", "warn", "Heads up");
    vi.advanceTimersByTime(5000);
    expect(banners.has("warn")).toBe(true);
  });

  it("restarts the time to live when the same banner is set again", () => {
    vi.useFakeTimers();
    banners.set("t", "info", "Again", { ttlMs: 1000 });
    vi.advanceTimersByTime(800);
    banners.set("t", "info", "Again", { ttlMs: 1000 });
    vi.advanceTimersByTime(800);
    expect(banners.has("t")).toBe(true);
    vi.advanceTimersByTime(200);
    expect(banners.has("t")).toBe(false);
  });

  it("cancels the old timer when a timed banner is replaced or cleared", () => {
    vi.useFakeTimers();
    banners.set("t", "info", "Old", { ttlMs: 1000 });
    banners.set("t", "info", "New");
    vi.advanceTimersByTime(2000);
    expect(host.textContent).toBe("New");
    banners.set("u", "info", "Timed", { ttlMs: 1000 });
    banners.clear("u");
    banners.set("u", "info", "Untimed");
    vi.advanceTimersByTime(2000);
    expect(banners.has("u")).toBe(true);
  });
});

describe("honorific spans", () => {
  it("wraps each honorific ligature in a .cap-hon span and keeps the text as it is", () => {
    const nodes = honNodes("The Prophet ﷺ said");
    const host = el("p", {}, nodes);
    expect(host.textContent).toBe("The Prophet ﷺ said");
    const spans = host.querySelectorAll("span.cap-hon");
    expect(spans).toHaveLength(1);
    expect(spans[0]?.textContent).toBe("ﷺ");
    expect(spans[0]?.getAttribute("lang")).toBe("ar");
  });

  it("returns one text node when there is no honorific", () => {
    const nodes = honNodes("Plain words");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.nodeType).toBe(Node.TEXT_NODE);
  });

  it("replaces an element's content", () => {
    const node = el("div", {}, [el("i", { text: "old" })]);
    setHonText(node, "Musa ﵇ and Allah ﷻ");
    expect(node.querySelector("i")).toBeNull();
    expect(node.textContent).toBe("Musa ﵇ and Allah ﷻ");
    expect(node.querySelectorAll(".cap-hon")).toHaveLength(2);
  });
});
