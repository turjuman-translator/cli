// Small DOM helpers shared by every page. Styles are set through the CSSOM only (CSP: no
// inline style attributes), and storage access is wrapped because it can throw (OBS, privacy
// modes, file:// …).

export interface ElProps {
  class?: string;
  text?: string;
  attrs?: Record<string, string>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) node.setAttribute(k, v);
  for (const child of children) node.append(child);
  return node;
}

/** Element by id with a type check; throws when the page template is out of sync. */
export function byId<T extends HTMLElement>(id: string, ctor: new () => T): T {
  const node = document.getElementById(id);
  if (!(node instanceof ctor)) throw new Error(`#${id} missing or not a ${ctor.name}`);
  return node;
}

export function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // storage unavailable: choices just aren't remembered
  }
}

/** ws:// or wss:// URL on this host for `path` (which may carry a query string). */
export function wsUrl(path: string): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}${path}`;
}

/** True when the page was opened from this machine (no access key needed). */
export function isLocalHost(hostname: string = window.location.hostname): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

/** "1:02:03" / "2:03" */
export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "1.24 s" / "–" */
export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "–";
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Set a CSS custom property or property via the CSSOM (allowed by the CSP). */
export function setStyle(node: HTMLElement, prop: string, value: string | null): void {
  if (value === null) node.style.removeProperty(prop);
  else node.style.setProperty(prop, value);
}
