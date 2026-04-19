import { describe, it, expect } from "vitest";
import { PACKAGE_VERSION, UsageComponent } from "../src/index.js";

describe("@agencer/usage-accountant", () => {
  it("exports the correct PACKAGE_VERSION", () => {
    expect(PACKAGE_VERSION).toBe("0.1.0");
  });

  it("exports UsageComponent with known sub-meters", () => {
    expect(UsageComponent.BRAIN_OPUS).toBe("brain.opus");
    expect(UsageComponent.TTS_CARTESIA).toBe("voice.tts_cartesia");
    expect(UsageComponent.FACT_RECALL).toBe("soft_logic.fact_recall");
  });

  it("UsageComponent has at least 10 sub-meters", () => {
    const keys = Object.keys(UsageComponent);
    expect(keys.length).toBeGreaterThanOrEqual(10);
  });
});
