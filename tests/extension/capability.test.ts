/**
 * Capability model tests (brief §1–4, §8):
 * browser-level vs page-level controllability must be distinguished.
 *
 *   chrome://newtab/          browser ✅  page ❌
 *   https://www.youtube.com   browser ✅  page ✅
 */
import { describe, it, expect } from "vitest";
import {
  pageUrlSupport,
  isControllablePageUrl,
  isUnsupportedPageUrl,
  pageCapability,
  isBrowserControllable,
  isPageControllable,
  actionCapabilityLevel,
} from "@/shared/pages";

describe("page capability model", () => {
  it("1. chrome://newtab/ allows browser control, rejects page control", () => {
    expect(pageUrlSupport("chrome://newtab/")).toBe("unsupported");
    expect(isUnsupportedPageUrl("chrome://newtab/")).toBe(true);
    expect(isControllablePageUrl("chrome://newtab/")).toBe(false);
    expect(pageCapability("chrome://newtab/")).toEqual({ browser: true, page: false });
    expect(isBrowserControllable(true)).toBe(true);
    expect(isPageControllable("chrome://newtab/")).toBe(false);
  });

  it("2. other internal pages (about:, extensions, devtools) are page-uncontrollable", () => {
    for (const url of ["about:blank", "chrome://extensions/", "edge://settings/", "devtools://x"]) {
      expect(pageCapability(url).browser).toBe(true);
      expect(pageCapability(url).page).toBe(false);
      expect(isPageControllable(url)).toBe(false);
    }
  });

  it("3/4. normal HTTPS pages allow both browser and page control", () => {
    expect(pageUrlSupport("https://www.youtube.com/")).toBe("controllable");
    expect(pageCapability("https://www.youtube.com/")).toEqual({ browser: true, page: true });
    expect(isBrowserControllable(true)).toBe(true);
    expect(isPageControllable("https://www.youtube.com/")).toBe(true);
  });

  it("no live tab means no browser control either", () => {
    expect(isBrowserControllable(false)).toBe(false);
  });

  it("browser-level actions never need DOM control", () => {
    for (const name of ["navigate", "new_tab", "close_tab", "switch_tab", "back", "forward", "reload"] as const) {
      expect(actionCapabilityLevel(name)).toBe("browser");
    }
  });

  it("webpage actions require page-level controllability", () => {
    for (const name of ["click", "double_click", "type", "clear", "select", "check", "uncheck", "radio", "scroll", "hover", "focus", "press_key", "wait", "extract", "submit"] as const) {
      expect(actionCapabilityLevel(name)).toBe("page");
    }
  });

  it("terminal actions resolve the task, not the page", () => {
    expect(actionCapabilityLevel("finish")).toBe("terminal");
    expect(actionCapabilityLevel("ask_user")).toBe("terminal");
  });
});
