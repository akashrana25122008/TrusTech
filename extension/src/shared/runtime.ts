/* ------------------------------------------------------------------ *
 * Shared extension runtime helpers — thin, platform-agnostic access to
 * the browser scripting API so the rest of the code never touches the
 * `chrome`/`browser` globals directly (see extension/src/browser/).
 * ------------------------------------------------------------------ */

export interface TabInfo {
  id: number;
  url?: string;
  title?: string;
}

/** Underlying browser object — guaranteed present inside an extension context. */
export function rawApi(): any {
  const globals = globalThis as any;
  if (typeof globals.chrome !== "undefined") return globals.chrome;
  if (typeof globals.browser !== "undefined") return globals.browser;
  throw new Error("[TrusTech] No extension API available in this context");
}

/** Firefox ships a promise-based `browser` namespace; detection is feature-based. */
export function isFirefoxRuntime(): boolean {
  try {
    return (
      typeof (globalThis as any).browser !== "undefined" &&
      typeof (globalThis as any).browser.sidebarAction !== "undefined"
    );
  } catch {
    return false;
  }
}