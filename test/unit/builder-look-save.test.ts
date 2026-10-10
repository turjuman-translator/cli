// @vitest-environment happy-dom
// Saving looks in the look editor (web/customize.ts): the save dialog and POST /api/presets, your
// own looks with their two-click delete (DELETE /api/presets/:id), the server default
// (POST /api/config/save-default), the refusals in the user's words, and who may save at all.
import { afterEach, describe, expect, it, vi } from "vitest";
import { THEME_VARS } from "../../src/shared/theme-vars.js";
import {
  $,
  all,
  type Browser,
  byId,
  type Call,
  closeBrowser,
  fire,
  input,
  type Reply,
  settle,
} from "./helpers/builder-dom.js";
import {
  bootLook,
  type CustomPreset,
  card,
  control,
  customPreset,
  frame,
  type LookOptions,
  part,
  themeQs,
  toastText,
} from "./helpers/builder-look.js";

const text = (id: string): string => (byId(id).textContent ?? "").trim();
const value = (id: string): string => byId<{ value: string }>(id).value;
const dialog = (): { open: boolean } => byId<{ open: boolean }>("save-dialog");

/** A server that keeps the looks it is sent. */
function presetStore(start: CustomPreset[] = [], def = "mosque-dark") {
  const looks = [...start];
  const state = { default: def };
  return {
    looks,
    state,
    install(b: Browser): void {
      b.api
        .on("GET", "/api/presets", () => ({
          body: { builtin: [], custom: looks, default: state.default },
        }))
        .on("POST", "/api/presets", (c: Call) => {
          const p = (c.body as { preset: CustomPreset }).preset;
          const at = looks.findIndex((x) => x.id === p.id);
          if (at >= 0) looks[at] = p;
          else looks.push(p);
          return { status: at >= 0 ? 200 : 201, body: { ok: true, preset: p } };
        })
        .on("DELETE", "/api/presets/hall", () => {
          looks.splice(
            looks.findIndex((x) => x.id === "hall"),
            1,
          );
          return { body: { ok: true } };
        })
        .on("POST", "/api/config/save-default", (c: Call) => {
          state.default = (c.body as { preset: string }).preset;
          return { body: { ok: true } };
        });
    },
  };
}

async function open(opts: LookOptions = {}, store = presetStore()) {
  const booted = await bootLook({
    ...opts,
    setup: (b) => {
      store.install(b);
      opts.setup?.(b);
    },
  });
  return { ...booted, store };
}

function clickSave(): void {
  byId<{ click(): void }>("save").click();
}

async function submit(): Promise<void> {
  fire(byId("save-form"), "submit");
  await settle();
  frame();
}

afterEach(() => closeBrowser());

describe("saving a look", () => {
  it("saves the edited look under a name and picks it", async () => {
    const { b, store } = await open();
    input(part(control("Panel", "Corner radius"), "input[type=range]"), "33");
    frame();
    clickSave();
    expect(dialog().open).toBe(true);
    expect(value("save-name")).toBe("Mosque dark (mine)");
    expect(value("save-desc")).toBe("");
    expect(text("save-text")).toBe(
      "Saves every setting of this look. Screens can then use it: preset=mosque-dark-mine.",
    );
    expect($("#save-text code").textContent).toBe("preset=mosque-dark-mine");
    expect(byId<{ hidden: boolean }>("save-overwrite").hidden).toBe(true);
    input(byId("save-name"), "  Main hall ");
    expect($("#save-text code").textContent).toBe("preset=main-hall");
    byId<{ value: string }>("save-desc").value = " For the big screen ";
    await submit();
    const sent = b.api.sent("POST", "/api/presets");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers).toEqual({
      Accept: "application/json",
      "Content-Type": "application/json",
    });
    const preset = (sent[0]?.body as { preset?: CustomPreset } | undefined)?.preset;
    expect(preset).toMatchObject({
      id: "main-hall",
      name: "Main hall",
      description: "For the big screen",
      options: { layout: "blocks", size: 52, pos: "bottom" },
    });
    // Every variable, so the look stays the same when a built-in one changes.
    expect(Object.keys(preset?.vars ?? {}).sort()).toEqual([...THEME_VARS].sort());
    expect(preset?.vars["--cap-panel-radius"]).toBe("33px");
    expect(store.looks.map((l) => l.id)).toEqual(["main-hall"]);
    expect(dialog().open).toBe(false);
    expect(toastText()).toBe("Saved · Main hall");
    expect(text("current-name")).toBe("Main hall");
    expect(themeQs()).toBe("preset=main-hall");
    expect(card("Main hall").textContent).toContain("Yours");
    expect(card("Main hall").classList.contains("is-active")).toBe(true);
    expect(byId<{ hidden: boolean }>("custom-note").hidden).toBe(true);
    expect(b.api.sent("GET", "/api/presets")).toHaveLength(2);
  });

  it("starts the dialog from the look itself", async () => {
    const hall = customPreset("hall", "Main hall", { description: "Big screen" });
    await open({}, presetStore([hall]));
    clickSave();
    // An unchanged built-in look: no name to suggest.
    expect(value("save-name")).toBe("");
    await submit();
    expect(text("save-error")).toBe("This can’t be empty.");
    expect(dialog().open).toBe(true);
    byId<{ click(): void }>("save-cancel").click();
    expect(dialog().open).toBe(false);
    // Your own look: its own name and description, and it will be updated.
    part<{ click(): void }>(card("Main hall"), ".pcard-main").click();
    frame();
    clickSave();
    expect(byId<{ hidden: boolean }>("save-error").hidden).toBe(true);
    expect(value("save-name")).toBe("Main hall");
    expect(value("save-desc")).toBe("Big screen");
    expect(byId<{ hidden: boolean }>("save-overwrite").hidden).toBe(true);
    input(byId("save-name"), "Hall");
    expect(byId<{ hidden: boolean }>("save-overwrite").hidden).toBe(false);
    expect(text("save-overwrite")).toBe("A look with this name exists and will be updated.");
    byId<{ click(): void }>("save-close").click();
    expect(dialog().open).toBe(false);
    clickSave();
    // A click inside the dialog keeps it; one on the backdrop (the dialog itself) closes it.
    byId<{ click(): void }>("save-name").click();
    expect(dialog().open).toBe(true);
    byId<{ click(): void }>("save-dialog").click();
    expect(dialog().open).toBe(false);
  });

  it("makes a link parameter of any name", async () => {
    await open();
    clickSave();
    const id = (name: string): string | null => {
      input(byId("save-name"), name);
      return $("#save-text code").textContent;
    };
    expect(id("Café Noir!!")).toBe("preset=cafe-noir");
    expect(id("Glass")).toBe("preset=glass-custom");
    expect(id("مسجد النور")).toBe("preset=my-look");
    expect(id(`${"a".repeat(50)}`)).toBe(`preset=${"a".repeat(40)}`);
  });

  it("says why the server refused the look, in our words where we have them", async () => {
    let reply: Reply = { status: 401 };
    await open({ setup: (b) => b.api.on("POST", "/api/presets", () => reply) });
    clickSave();
    input(byId("save-name"), "Main hall");
    const refusal = async (r: Reply): Promise<string> => {
      reply = r;
      await submit();
      expect(byId<{ disabled: boolean }>("save-confirm").disabled).toBe(false);
      expect(dialog().open).toBe(true);
      return text("save-error");
    };
    expect(await refusal({ status: 401 })).toBe("Please log in again to save looks.");
    expect(await refusal({ status: 403 })).toBe("Only an owner or admin can save looks.");
    expect(await refusal({ status: 429, headers: { "Retry-After": "300" } })).toBe(
      "Too many attempts. Try again in 5 minutes.",
    );
    expect(await refusal({ status: 429 })).toBe(
      "Too many attempts. Wait a few minutes, then try again.",
    );
    expect(await refusal({ status: 400, body: { ok: false, message: "Name too long" } })).toBe(
      "Name too long",
    );
    expect(await refusal({ status: 400, body: { ok: false, message: 7 } })).toBe(
      "Something went wrong (HTTP 400).",
    );
    expect(await refusal({ status: 500, body: { message: "stack trace" } })).toBe(
      "The server had a problem. Try again in a moment.",
    );
    expect(await refusal({ status: 409, body: "taken" })).toBe("Something went wrong (HTTP 409).");
    expect(await refusal({ status: 418, raw: "I'm a teapot" })).toBe(
      "Something went wrong (HTTP 418).",
    );
    expect(await refusal("network-error")).toBe(
      "Can’t reach the server. Check the connection and try again.",
    );
  });

  it("says Saves… for a screen on a hosted mosque, and follows the language", async () => {
    await open({ mode: "hosted" });
    clickSave();
    expect(text("save-text")).toBe(
      "Saves every setting of this look, so you can choose it for a screen.",
    );
    await open();
    clickSave();
    ($('.lang-btn[lang="nl"]') as unknown as { click(): void }).click();
    expect(text("save-text")).toBe(
      "Slaat elke instelling van deze stijl op. Schermen kunnen hem dan gebruiken: preset=my-look.",
    );
  });

  it("sends a legacy ?token= as a Bearer header", async () => {
    const { b } = await open({ url: "http://127.0.0.1:8765/app/look?token=abc" });
    expect(themeQs()).toBe("");
    expect(b.api.sent("GET", "/api/presets")[0]?.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer abc",
    });
    expect(byId<{ href: string }>("open-preview").href).toBe(
      "http://127.0.0.1:8765/app/look?view=preview&to=nl&token=abc",
    );
    clickSave();
    input(byId("save-name"), "Mine");
    await submit();
    expect(b.api.sent("POST", "/api/presets")[0]?.headers).toEqual({
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: "Bearer abc",
    });
  });
});

describe("your looks", () => {
  const hall = customPreset("hall", "Main hall");
  const chapel = customPreset("chapel", "Chapel", { description: "Small room" });

  it("lists them with a two-click delete", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { b, store } = await open({}, presetStore([hall, chapel]));
    expect(
      all("#custom-gallery .pcard").map((c) => c.querySelector(".pcard-name")?.textContent),
    ).toEqual(["Main hall", "Chapel"]);
    expect(card("Chapel").querySelector(".pcard-desc")?.textContent).toBe("Small room");
    part<{ click(): void }>(card("Main hall"), ".pcard-main").click();
    frame();
    const del = part<{ click(): void; textContent: string; classList: DOMTokenList }>(
      card("Main hall"),
      ".pcard-del",
    );
    expect(part(card("Main hall"), ".pcard-del").getAttribute("aria-label")).toBe(
      "Delete “Main hall”",
    );
    del.click();
    expect(del.textContent).toBe("Delete?");
    expect(del.classList.contains("is-armed")).toBe(true);
    // Not confirmed in time: back to the bin.
    vi.advanceTimersByTime(3000);
    expect(del.classList.contains("is-armed")).toBe(false);
    expect(del.textContent).toBe("");
    expect(b.api.sent("DELETE", "/api/presets/hall")).toHaveLength(0);
    del.click();
    del.click();
    await settle();
    frame();
    expect(b.api.sent("DELETE", "/api/presets/hall")).toHaveLength(1);
    expect(store.looks.map((l) => l.id)).toEqual(["chapel"]);
    // The look that was open is gone: back to the server's default.
    expect(text("current-name")).toBe("Mosque dark");
    expect(toastText()).toBe("Deleted · Main hall");
  });

  it("deletes a look that isn't open, and reports a refusal", async () => {
    const { b } = await open({}, presetStore([hall, chapel]));
    part<{ click(): void }>(card("Chapel"), ".pcard-main").click();
    frame();
    const del = (): { click(): void } => part(card("Main hall"), ".pcard-del");
    del().click();
    del().click();
    await settle();
    frame();
    expect(text("current-name")).toBe("Chapel");
    expect(all("#custom-gallery .pcard")).toHaveLength(1);
    b.api.on("DELETE", "/api/presets/chapel", { status: 403 });
    const delChapel = part<{ click(): void }>(card("Chapel"), ".pcard-del");
    delChapel.click();
    delChapel.click();
    await settle();
    expect(toastText()).toBe("Only an owner or admin can save looks.");
    expect($("#toast").classList.contains("is-error")).toBe(true);
    expect(text("current-name")).toBe("Chapel");
  });

  it("makes a look the server's default", async () => {
    const { b } = await open({}, presetStore([hall], "hall"));
    expect(card("Main hall").textContent).toContain("Default");
    // Links name a look unless it is the default.
    expect(themeQs()).toBe("preset=mosque-dark");
    part<{ click(): void }>(card("Glass"), ".pcard-main").click();
    frame();
    expect(themeQs()).toBe("preset=glass");
    byId<{ click(): void }>("make-default").click();
    await settle();
    frame();
    expect(b.api.sent("POST", "/api/config/save-default")[0]?.body).toEqual({ preset: "glass" });
    expect(toastText()).toBe("“Glass” is now the default look");
    expect(card("Glass").textContent).toContain("Default");
    expect(card("Main hall").textContent).toContain("Yours");
    expect(themeQs()).toBe("");
    expect(text("make-default")).toBe("This is the default");
    expect(text("default-note")).toContain("Glass");
    b.api.on("POST", "/api/config/save-default", {
      status: 400,
      body: { message: 'Unknown preset "cinema"' },
    });
    part<{ click(): void }>(card("Cinema"), ".pcard-main").click();
    frame();
    byId<{ click(): void }>("make-default").click();
    await settle();
    expect(toastText()).toBe('Unknown preset "cinema"');
  });

  it("lets a user look but not save", async () => {
    const { b } = await open({ role: "user" }, presetStore([hall]));
    expect(byId<{ hidden: boolean }>("save").hidden).toBe(true);
    expect(byId<{ hidden: boolean }>("make-default").hidden).toBe(true);
    expect(text("use-lead")).toBe("Only an owner or admin can save looks.");
    expect(byId<{ hidden: boolean }>("custom-note").hidden).toBe(false);
    expect(text("custom-note")).toBe("Only an owner or admin can save looks.");
    expect(card("Main hall").querySelector(".pcard-del")).toBeNull();
    clickSave();
    expect(dialog().open).toBe(false);
    expect(b.api.sent("POST", "/api/presets")).toHaveLength(0);
  });

  it("says when the server's looks can't be loaded", async () => {
    await open({ setup: (b) => b.api.on("GET", "/api/presets", { status: 500 }) });
    expect(text("custom-note")).toBe(
      "Your looks can’t be loaded: the server didn’t answer. The built-in looks still work.",
    );
    part<{ click(): void }>(card("Glass"), ".pcard-main").click();
    frame();
    expect(byId<{ disabled: boolean }>("make-default").disabled).toBe(true);
  });

  it("gives up on a server that doesn't answer within 2.5 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let aborted = false;
    await open({
      setup: (b) =>
        b.api.on("GET", "/api/presets", (c) => {
          return new Promise<Reply>((_, reject) => {
            c.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          });
        }),
    });
    expect(aborted).toBe(false);
    vi.advanceTimersByTime(2500);
    await settle();
    frame();
    expect(aborted).toBe(true);
    expect(text("custom-note")).toBe(
      "Your looks can’t be loaded: the server didn’t answer. The built-in looks still work.",
    );
  });

  it("reads the server's list carefully", async () => {
    await open({
      setup: (b) =>
        b.api.on("GET", "/api/presets", {
          body: {
            custom: [hall, { id: "glass", name: "Fake glass", vars: {}, options: {} }, null],
            default: 42,
          },
        }),
    });
    expect(all("#custom-gallery .pcard")).toHaveLength(1);
    expect(card("Mosque dark").textContent).toContain("Default");
    for (const raw of ["[]", "null"]) {
      await open({ setup: (b) => b.api.on("GET", "/api/presets", { raw }) });
      expect(all("#custom-gallery .pcard")).toHaveLength(0);
    }
    expect(text("custom-note")).toBe(
      "Looks you save with “Save as a look…” appear here, ready for your screens.",
    );
  });
});
