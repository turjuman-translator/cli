// @vitest-environment happy-dom
// The app's small UI kit (web/admin-ui.ts): icons and buttons, the toast, sheets (confirm, prompt
// and the ⋯ menu), generated passwords and copying to the clipboard.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  actionSheet,
  button,
  confirmSheet,
  copyText,
  fmtWhen,
  generatePassword,
  ICONS,
  icon,
  openSheet,
  promptSheet,
  toast,
} from "../../web/admin-ui.js";
import { setLang } from "../../web/shared/app-i18n.js";
import { $, $$, buttonByText, settle, sheet, text, toastText } from "./helpers/web-app-page.js";

beforeEach(() => {
  setLang("en");
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "Date"],
    now: new Date(2026, 9, 9, 18, 42),
  });
  document.body.innerHTML = "";
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const d of document.querySelectorAll("dialog")) d.remove();
});

describe("app UI: icons and buttons", () => {
  it("draws a stroke icon, hidden from screen readers", () => {
    const svg = icon("check", 15);
    expect(svg.getAttribute("width")).toBe("15");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    const path = svg.querySelector("path");
    expect(path?.getAttribute("d")).toBe(ICONS.check);
    expect(path?.getAttribute("stroke-width")).toBe("2");
    // The dots of ⋯ are drawn thicker.
    expect(icon("more").querySelector("path")?.getAttribute("stroke-width")).toBe("3.2");
    expect(icon("more").getAttribute("height")).toBe("22");
  });

  it("makes a plain button, or one with a kind, an icon, a type and a title", () => {
    const plain = button("Cancel");
    expect(plain.className).toBe("ui-btn ui-btn-secondary");
    expect(plain.type).toBe("button");
    expect(plain.querySelector("svg")).toBeNull();
    expect(plain.title).toBe("");
    const save = button("Save", {
      kind: "primary",
      icon: "check",
      type: "submit",
      title: "Save it",
    });
    expect(save.className).toBe("ui-btn ui-btn-primary");
    expect(save.type).toBe("submit");
    expect(save.querySelector("svg")).not.toBeNull();
    expect(save.title).toBe("Save it");
    expect(text("span", save)).toBe("Save");
  });
});

describe("app UI: the toast", () => {
  it("shows a message for a moment, an error a little longer", async () => {
    toast("Saved · Hall");
    const node = $("#toast");
    expect(node.getAttribute("role")).toBe("status");
    expect(toastText()).toBe("Saved · Hall");
    expect(node.classList.contains("is-error")).toBe(false);
    await vi.advanceTimersByTimeAsync(2599);
    expect(node.hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(node.hidden).toBe(true);

    toast("Couldn't save", "error");
    expect(node.classList.contains("is-error")).toBe(true);
    expect(node.querySelector("path")?.getAttribute("d")).toBe(ICONS.close);
    await vi.advanceTimersByTimeAsync(4999);
    expect(toastText()).toBe("Couldn't save");
    await vi.advanceTimersByTimeAsync(1);
    expect(toastText()).toBe("");
  });

  it("uses the page's own toast element, and a new message restarts the time", async () => {
    document.body.innerHTML = '<div id="toast" class="ui-toast" role="status" hidden></div>';
    toast("one");
    await vi.advanceTimersByTimeAsync(2000);
    toast("two");
    await vi.advanceTimersByTimeAsync(2000);
    expect(toastText()).toBe("two");
    expect($$("#toast")).toHaveLength(1);
  });
});

describe("app UI: sheets", () => {
  it("opens a titled modal sheet and closes it with ✕, removing it", () => {
    const onClose = vi.fn();
    const s = openSheet("Hall", [document.createTextNode("body text")], onClose);
    expect(s.dialog.open).toBe(true);
    const title = $("h2", s.dialog);
    expect(title.textContent).toBe("Hall");
    expect(s.dialog.getAttribute("aria-labelledby")).toBe(title.id);
    expect(text(".ui-sheet-body", s.dialog)).toBe("body text");
    const close = $<HTMLButtonElement>(".ui-sheet-close", s.dialog);
    expect(close.getAttribute("aria-label")).toBe("Close");
    close.click();
    expect(s.dialog.isConnected).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    s.close(); // closing twice is harmless
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a click on the backdrop, not on one inside", () => {
    const s = openSheet("Hall", []);
    s.body.click();
    expect(s.dialog.open).toBe(true);
    s.dialog.click();
    expect(s.dialog.open).toBe(false);
  });

  it("confirms: yes, no, or closed", async () => {
    let answer = confirmSheet({
      title: "Delete?",
      message: "Gone for good.",
      confirm: "Delete",
      danger: true,
    });
    expect(text(".ui-sheet-text", sheet())).toBe("Gone for good.");
    const yes = buttonByText("Delete", sheet());
    expect(yes.className).toBe("ui-btn ui-btn-danger");
    expect(document.activeElement).toBe(yes);
    yes.click();
    expect(await answer).toBe(true);

    answer = confirmSheet({ title: "Clear?", message: "", confirm: "Clear" });
    expect(buttonByText("Clear", sheet()).className).toBe("ui-btn ui-btn-primary");
    buttonByText("Cancel", sheet()).click();
    expect(await answer).toBe(false);

    answer = confirmSheet({ title: "Clear?", message: "", confirm: "Clear" });
    $<HTMLButtonElement>(".ui-sheet-close", sheet()).click();
    expect(await answer).toBe(false);
    expect($$("dialog")).toHaveLength(0);
  });

  it("asks for a text, refuses an empty one and returns it trimmed", async () => {
    const answer = promptSheet({
      title: "Rename",
      label: "Name",
      value: "Hall",
      confirm: "Save",
      hint: "As people know it",
    });
    const input = $<HTMLInputElement>("input", sheet());
    expect(input.value).toBe("Hall");
    expect(input.maxLength).toBe(80);
    expect(document.activeElement).toBe(input);
    expect(text("label", sheet())).toBe("Name");
    expect(text(".ui-hint", sheet())).toBe("As people know it");
    input.value = "   ";
    buttonByText("Save", sheet()).click();
    await settle(1);
    expect(text(".ui-field-error", sheet())).toBe("This can’t be empty.");
    expect($(".ui-field-error", sheet()).hidden).toBe(false);
    input.value = "  Main hall ";
    buttonByText("Save", sheet()).click();
    expect(await answer).toBe("Main hall");
  });

  it("returns null when the question is cancelled", async () => {
    const answer = promptSheet({
      title: "Rename",
      label: "Name",
      value: "",
      confirm: "Save",
      maxLength: 20,
    });
    expect($<HTMLInputElement>("input", sheet()).maxLength).toBe(20);
    expect($$(".ui-hint", sheet())).toHaveLength(0);
    buttonByText("Cancel", sheet()).click();
    expect(await answer).toBeNull();
  });

  it("lists actions as big buttons; one closes the sheet and runs", () => {
    const rename = vi.fn();
    const remove = vi.fn();
    const extra = document.createElement("p");
    extra.textContent = "Logged in as imam";
    actionSheet(
      "Hall",
      [
        { label: "Rename", icon: "edit", run: rename },
        { label: "Delete", icon: "trash", danger: true, hint: "Can't be undone", run: remove },
      ],
      [extra],
    );
    const s = sheet();
    const [first, second] = $$<HTMLButtonElement>(".ui-sheet-action", s);
    expect(first?.className).toBe("ui-sheet-action");
    expect(second?.className).toBe("ui-sheet-action is-danger");
    expect(text(".ui-sheet-action-hint", s)).toBe("Can't be undone");
    expect(text(".ui-sheet-body > p", s)).toBe("Logged in as imam");
    second?.click();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(rename).not.toHaveBeenCalled();
    expect(s.isConnected).toBe(false);
  });
});

describe("app UI: passwords and copying", () => {
  it("generates readable passwords in groups", () => {
    const pw = generatePassword();
    expect(pw).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{5}-[a-km-zA-HJ-NP-Z2-9]{5}-[a-km-zA-HJ-NP-Z2-9]{4}$/);
    expect(generatePassword(5)).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{5}$/);
    expect(generatePassword()).not.toBe(pw);
  });

  function secure(on: boolean): void {
    Object.defineProperty(window, "isSecureContext", { value: on, configurable: true });
  }
  function execCommand(impl: () => boolean): ReturnType<typeof vi.fn> {
    const fn = vi.fn(impl);
    Object.defineProperty(document, "execCommand", { value: fn, configurable: true });
    return fn;
  }
  afterEach(() => {
    Reflect.deleteProperty(window, "isSecureContext");
    Reflect.deleteProperty(document, "execCommand");
  });

  it("copies with the clipboard on a secure page", async () => {
    secure(true);
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    expect(await copyText("https://turjuman.example/feed/abc")).toBe(true);
    expect(write).toHaveBeenCalledWith("https://turjuman.example/feed/abc");
  });

  it("falls back to selecting the text when the clipboard refuses", async () => {
    secure(true);
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    let selected = "";
    const copy = execCommand(() => {
      selected = $<HTMLTextAreaElement>("textarea.ui-sr-only").value;
      return true;
    });
    expect(await copyText("the link")).toBe(true);
    expect(copy).toHaveBeenCalledWith("copy");
    expect(selected).toBe("the link");
    expect($$("textarea")).toHaveLength(0);
  });

  it("falls back on a plain-http page, and says when even that fails", async () => {
    secure(false);
    const write = vi.spyOn(navigator.clipboard, "writeText");
    execCommand(() => false);
    expect(await copyText("x")).toBe(false);
    execCommand(() => {
      throw new Error("not supported");
    });
    expect(await copyText("x")).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect($$("textarea")).toHaveLength(0);
  });

  it("writes times of today short, and others with the day", () => {
    expect(fmtWhen(new Date(2026, 9, 9, 9, 5).getTime())).toBe("09:05");
    expect(fmtWhen(new Date(2026, 9, 2, 18, 42).getTime())).toBe("2 Oct, 18:42");
  });
});
