// Honorific ligatures in caption text: each ﷺ / ﷾ / ﵇ … becomes <span class="cap-hon" lang="ar"> so
// it can be styled neatly; the text itself never changes.
import "./hon.css";
import { splitHonorifics } from "../../src/text/honorifics.js";

/** Text and `.cap-hon` nodes for `text` (one text node when there is no honorific). */
export function honNodes(text: string): Node[] {
  return splitHonorifics(text).map((run) => {
    if (!run.honorific) return document.createTextNode(run.text);
    const span = document.createElement("span");
    span.className = "cap-hon";
    span.lang = "ar";
    span.textContent = run.text;
    return span;
  });
}

/** Replace `node`'s content with `text`, honorifics wrapped. */
export function setHonText(node: Element, text: string): void {
  node.replaceChildren(...honNodes(text));
}
