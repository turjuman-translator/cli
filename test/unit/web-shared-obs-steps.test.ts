// @vitest-environment happy-dom
// "Show on a screen" (web/shared/obs-steps.ts): the feed link with Copy and Open, the OBS steps
// (strip or full picture), and in local mode the choice between this computer's link and the HTTPS
// link for other devices, or how to set HTTPS up. The where-choice is module state: each test
// loads a fresh module.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settle, setUrl } from "./helpers/web-shared-fakes.js";

type Obs = typeof import("../../web/shared/obs-steps.js");

async function fresh(): Promise<Obs> {
  vi.resetModules();
  return import("../../web/shared/obs-steps.js");
}

function q<T extends Element>(sel: string, root: ParentNode = document): T {
  const node = root.querySelector<T>(sel);
  if (!node) throw new Error(`${sel} not found`);
  return node;
}

const LOCAL = "http://127.0.0.1:8765/feed/abc";
const SECURE = "https://192.168.1.5:8443/feed/abc";

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
  setUrl("http://localhost:8765/app");
});

afterEach(() => {
  Reflect.deleteProperty(window, "isSecureContext");
  vi.restoreAllMocks();
  setUrl("http://localhost:3000/");
});

describe("obs steps: the picture size", () => {
  it("takes the layout from the link, else from its look", async () => {
    const obs = await fresh();
    expect(obs.isRollup("layout=rollup")).toBe(true);
    expect(obs.isRollup("layout=blocks&preset=lower-third")).toBe(false);
    expect(obs.isRollup("preset=lower-third")).toBe(true);
    expect(obs.isRollup("preset=cinema&size=60")).toBe(true);
    expect(obs.isRollup("")).toBe(false);
    expect(obs.isRollup("preset=mosque-light")).toBe(false);
  });

  it("numbers the OBS steps with a 1920 × 1080 picture for blocks", async () => {
    const obs = await fresh();
    const guide = obs.obsGuide({ rollup: false });
    const titles = [...guide.querySelectorAll(".obs-title")].map((n) => n.textContent);
    expect(titles).toEqual(["OBS Studio", "Without OBS"]);
    const steps = [...guide.querySelectorAll("ol.obs-steps > li")];
    expect(steps).toHaveLength(5);
    expect(steps[2]?.textContent).toBe("Width 1920, height 1080.");
    expect(steps[1]?.textContent).toBe("Sources → + → Browser, and paste the link.");
    // The launch flag per operating system, never broken at its hyphens.
    const os = q("dl.obs-os", guide);
    expect([...os.querySelectorAll("dt")].map((n) => n.textContent)).toEqual([
      "Windows",
      "macOS",
      "Linux",
    ]);
    const dds = [...os.querySelectorAll("dd")].map((n) => n.textContent);
    expect(dds).toEqual([
      "add --enable-media-stream to the Target of the OBS shortcut",
      "/Applications/OBS.app/Contents/MacOS/OBS --enable-media-stream",
      "obs --enable-media-stream",
    ]);
    expect(os.querySelectorAll("code.obs-flag")).toHaveLength(3);
    // OBS's own option names stay in English, left to right.
    const names = [...guide.querySelectorAll<HTMLElement>(".obs-ui")];
    expect(names.map((n) => n.textContent)).toEqual([
      "Shutdown source when not visible",
      "Refresh browser when scene becomes active",
      "Open Scene Projector",
    ]);
    for (const n of names) {
      expect(n.lang).toBe("en");
      expect(n.dir).toBe("ltr");
    }
    expect(steps[4]?.textContent).toBe(
      "On a TV: right-click the scene → Open Scene Projector → the TV.",
    );
    expect(q(".obs-other", guide).textContent).toContain("F11");
  });

  it("makes the roll-up strip 1920 × 400", async () => {
    const obs = await fresh();
    const guide = obs.obsGuide({ rollup: true });
    expect(guide.querySelectorAll("ol.obs-steps > li")[2]?.textContent).toBe(
      "Width 1920, height 400.",
    );
  });
});

describe("obs steps: the link", () => {
  it("shows the link read-only with its label, hint and an Open link", async () => {
    const obs = await fresh();
    const block = obs.linkBlock(SECURE);
    document.body.append(block);
    const input = q<HTMLInputElement>("input.sos-url", block);
    expect(input.value).toBe(SECURE);
    expect(input.readOnly).toBe(true);
    expect(input.dir).toBe("ltr");
    expect(q("label", block).getAttribute("for")).toBe(input.id);
    expect(q("label", block).textContent).toBe("Screen link");
    const hint = q(`#${input.id}-hint`, block);
    expect(input.getAttribute("aria-describedby")).toBe(hint.id);
    expect(hint.textContent).toBe("Keep it private: anyone with this link can show this screen.");
    const open = q<HTMLAnchorElement>("a.sos-open", block);
    expect(open.getAttribute("href")).toBe(SECURE);
    expect(open.target).toBe("_blank");
    expect(open.rel).toBe("noopener");
    expect(open.textContent).toBe("Open");
    // Every link block gets its own ids.
    expect(obs.linkBlock(SECURE).querySelector("input")?.id).not.toBe(input.id);
  });

  it("selects the whole link when it gets focus", async () => {
    const obs = await fresh();
    const block = obs.linkBlock(SECURE);
    document.body.append(block);
    const input = q<HTMLInputElement>("input", block);
    const select = vi.spyOn(input, "select");
    input.dispatchEvent(new FocusEvent("focus"));
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("copies the link and says so", async () => {
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const obs = await fresh();
    const block = obs.linkBlock(SECURE);
    document.body.append(block);
    const copy = q<HTMLButtonElement>("button.ui-btn-primary", block);
    expect(copy.textContent).toBe("Copy link");
    copy.click();
    await settle();
    expect(write).toHaveBeenCalledWith(SECURE);
    const toast = q("#toast");
    expect(toast.textContent).toBe("Link copied");
    expect(toast.classList.contains("is-error")).toBe(false);
  });

  it("says when copying failed", async () => {
    // No secure context and no execCommand: nothing can copy.
    const obs = await fresh();
    const block = obs.linkBlock(SECURE);
    document.body.append(block);
    q<HTMLButtonElement>("button.ui-btn-primary", block).click();
    await settle();
    const toast = q("#toast");
    expect(toast.textContent).toBe("Copy failed");
    expect(toast.classList.contains("is-error")).toBe(true);
  });

  it("says where the page listens", async () => {
    const obs = await fresh();
    expect(obs.micNote().textContent).toBe(
      "The page listens through the microphone of the computer that shows it.",
    );
  });
});

describe("obs steps: which link", () => {
  it("copies the public link on a hosted server", async () => {
    const obs = await fresh();
    expect(obs.chosenLink({ url: SECURE, localUrl: LOCAL, query: "" }, "hosted")).toBe(SECURE);
  });

  it("prefers this computer's link in local mode, else the HTTPS one, else none", async () => {
    const obs = await fresh();
    const url = "http://localhost:8765/feed/abc";
    expect(obs.chosenLink({ url, localUrl: LOCAL, secureUrl: SECURE, query: "" }, "local")).toBe(
      LOCAL,
    );
    expect(obs.chosenLink({ url, localUrl: null, secureUrl: SECURE, query: "" }, "local")).toBe(
      SECURE,
    );
    expect(obs.chosenLink({ url, query: "" }, "local")).toBeNull();
  });

  it("follows the choice made in the panel", async () => {
    const obs = await fresh();
    const view = { url: LOCAL, localUrl: LOCAL, secureUrl: SECURE, query: "" };
    const root = obs.showOnScreen(view, "local");
    document.body.append(root);
    const [here, elsewhere] = root.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(here?.checked).toBe(true);
    expect(elsewhere?.checked).toBe(false);
    if (!here || !elsewhere) throw new Error("no radios");
    elsewhere.checked = true;
    elsewhere.dispatchEvent(new Event("change"));
    expect(obs.chosenLink(view, "local")).toBe(SECURE);
    // An unchecked radio's change event changes nothing.
    here.dispatchEvent(new Event("change"));
    expect(obs.chosenLink(view, "local")).toBe(SECURE);
    here.checked = true;
    here.dispatchEvent(new Event("change"));
    expect(obs.chosenLink(view, "local")).toBe(LOCAL);
    // "Here" without a local link (e.g. after a server change): the HTTPS link.
    expect(
      obs.chosenLink({ url: SECURE, localUrl: null, secureUrl: SECURE, query: "" }, "local"),
    ).toBe(SECURE);
  });
});

describe("obs steps: show on a screen", () => {
  it("shows the public link, the microphone fact and the steps when hosted", async () => {
    const obs = await fresh();
    const root = obs.showOnScreen({ url: SECURE, query: "layout=rollup" }, "hosted");
    expect(q<HTMLInputElement>("input.sos-url", root).value).toBe(SECURE);
    expect(root.querySelector(".sos-mic")).not.toBeNull();
    expect(root.querySelector("fieldset")).toBeNull();
    expect(root.querySelectorAll("ol.obs-steps > li")[2]?.textContent).toBe(
      "Width 1920, height 400.",
    );
    const bare = obs.showOnScreen({ url: SECURE, query: "" }, "hosted", { guide: false });
    expect(bare.querySelector(".obs-guide")).toBeNull();
    expect(bare.querySelector(".sos-link")).not.toBeNull();
  });

  it("lets a local install choose this computer or another device", async () => {
    const obs = await fresh();
    const root = obs.showOnScreen(
      { url: LOCAL, localUrl: LOCAL, secureUrl: SECURE, query: "" },
      "local",
    );
    document.body.append(root);
    const legend = q("fieldset.sos-where legend", root);
    expect(legend.textContent).toBe("Where does OBS or the browser run?");
    const titles = [...root.querySelectorAll(".sos-where-title")].map((n) => n.textContent);
    expect(titles).toEqual(["On this computer", "On another computer or TV"]);
    const hints = [...root.querySelectorAll(".sos-where-hint")].map((n) => n.textContent);
    expect(hints).toEqual(["The one that runs Turjuman", "Over HTTPS on your network"]);
    const radios = [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    expect(q<HTMLInputElement>(".sos-slot input.sos-url", root).value).toBe(LOCAL);
    const elsewhere = radios[1];
    if (!elsewhere) throw new Error("no radio");
    elsewhere.checked = true;
    elsewhere.dispatchEvent(new Event("change"));
    expect(q<HTMLInputElement>(".sos-slot input.sos-url", root).value).toBe(SECURE);
    expect(root.querySelector(".obs-guide")).not.toBeNull();
  });

  it("remembers the choice for the next panel while the page is open", async () => {
    const obs = await fresh();
    const view = { url: LOCAL, localUrl: LOCAL, secureUrl: SECURE, query: "" };
    const first = obs.showOnScreen(view, "local");
    const elsewhere = first.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1];
    if (!elsewhere) throw new Error("no radio");
    elsewhere.checked = true;
    elsewhere.dispatchEvent(new Event("change"));
    const second = obs.showOnScreen(view, "local");
    const radios = second.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(radios[1]?.checked).toBe(true);
    expect(q<HTMLInputElement>(".sos-slot input.sos-url", second).value).toBe(SECURE);
  });

  it("explains HTTPS when another device is chosen and there is no HTTPS link", async () => {
    setUrl("http://192.168.1.5:8765/app");
    const obs = await fresh();
    const root = obs.showOnScreen(
      { url: LOCAL, localUrl: LOCAL, secureUrl: null, query: "" },
      "local",
    );
    const elsewhere = root.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1];
    if (!elsewhere) throw new Error("no radio");
    elsewhere.checked = true;
    elsewhere.dispatchEvent(new Event("change"));
    const help = q(".sos-https", root);
    expect(help.getAttribute("role")).toBe("note");
    expect(q(".sos-https-title", help).textContent).toBe("This needs HTTPS on your network");
    const steps = [...help.querySelectorAll("ol > li")].map((n) => n.textContent);
    expect(steps).toEqual([
      "On the Turjuman computer, make a certificate: bash scripts/lan-cert.sh tls (Docker: make lan-cert)",
      "In config.yaml, set server.exposure: lan and server.https.port: 8443. Docker: also set CAPTIONS_BIND=0.0.0.0 in .env.",
      "Restart Turjuman (Docker: make restart).",
      // Opened over the LAN: the CA comes from this very address.
      "On the other device, install http://192.168.1.5:8765/ca.crt once.",
    ]);
    expect(q(".sos-https-more", help).textContent).toBe(
      "Then the HTTPS link appears here. More in docs/guide.md, “HTTPS on the LAN”.",
    );
    expect(root.querySelector(".sos-slot .sos-link")).toBeNull();
  });

  it("offers no choice without a link for this computer", async () => {
    const obs = await fresh();
    const root = obs.showOnScreen(
      { url: SECURE, localUrl: null, secureUrl: SECURE, query: "" },
      "local",
    );
    expect(root.querySelector("fieldset")).toBeNull();
    expect(q<HTMLInputElement>(".sos-slot input.sos-url", root).value).toBe(SECURE);
  });

  it("drops an earlier 'this computer' choice once that link is gone", async () => {
    const obs = await fresh();
    obs.showOnScreen({ url: LOCAL, localUrl: LOCAL, secureUrl: SECURE, query: "" }, "local");
    const root = obs.showOnScreen(
      { url: SECURE, localUrl: null, secureUrl: null, query: "" },
      "local",
      {
        guide: false,
      },
    );
    expect(root.querySelector(".sos-https")).not.toBeNull();
    expect(root.querySelector(".obs-guide")).toBeNull();
  });

  /** The CA line of the HTTPS help, opened at `url`. */
  async function caLine(url: string): Promise<string | null | undefined> {
    setUrl(url);
    const obs = await fresh();
    const root = obs.showOnScreen({ url, localUrl: null, secureUrl: null, query: "" }, "local");
    return root.querySelectorAll(".sos-https ol > li")[3]?.textContent;
  }

  it("names the CA address for each way the page was opened", async () => {
    // On the server itself the other device can't use localhost: a placeholder with the port.
    expect(await caLine("http://localhost:9000/app")).toBe(
      "On the other device, install http://<server>:9000/ca.crt once.",
    );
    expect(await caLine("http://127.0.0.1/app")).toBe(
      "On the other device, install http://<server>:8765/ca.crt once.",
    );
    expect(await caLine("http://[::1]:8765/app")).toBe(
      "On the other device, install http://<server>:8765/ca.crt once.",
    );
    // Over HTTPS the plain-http port is unknown: the default.
    expect(await caLine("https://mosque.example:8443/app")).toBe(
      "On the other device, install http://<server>:8765/ca.crt once.",
    );
  });
});
