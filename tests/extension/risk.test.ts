import { describe, it, expect } from "vitest";
import { assessAction } from "@/security/riskEngine";

describe("ActionRiskEngine", () => {
  it("flags financial interactions as high risk", () => {
    const advice = assessAction({ command: "click", intentPhrase: "buy train ticket", domain: "irctc.co.in" });
    expect(advice.level).toBe("high");
    expect(advice.needsConfirmation).toBe(true);
    expect(advice.allow).toBe(false);
  });

  it("approval unlocks a previously high-risk action", () => {
    const advice = assessAction({ command: "click", intentPhrase: "pay now", userConfirmed: true });
    expect(advice.level).toBe("high");
    expect(advice.allow).toBe(true);
  });

  it("treats destructive actions as high risk", () => {
    const advice = assessAction({ command: "click", intentPhrase: "delete my account" });
    expect(advice.level).toBe("high");
  });

  it("treats credential autofill as high risk", () => {
    const advice = assessAction({ command: "type", intentPhrase: "login with password and otp" });
    expect(advice.level).toBe("high");
  });

  it("lets trusted-domain browsing through as low risk", () => {
    const advice = assessAction({ command: "click", intentPhrase: "open tutorial", domain: "youtube.com" });
    expect(advice.level).toBe("low");
    expect(advice.needsConfirmation).toBe(false);
    expect(advice.allow).toBe(true);
  });

  it("blocks when privacy inspection fails", () => {
    const advice = assessAction({ command: "type", intentPhrase: "anything", privacyBlocked: true });
    expect(advice.allow).toBe(false);
    expect(advice.level).toBe("high");
  });
});