import { describe, it, expect } from "vitest";
import { PACKAGE_VERSION, SUB_METERS } from "../src/index.js";

describe("@agencer/usage-accountant", () => {
  it("exports the correct PACKAGE_VERSION", () => {
    expect(PACKAGE_VERSION).toBe("@agencer/usage-accountant/0.1.0-alpha.0");
  });

  it("exports SUB_METERS as a non-empty array", () => {
    expect(SUB_METERS.length).toBeGreaterThan(0);
  });

  it("includes known sub-meters", () => {
    expect(SUB_METERS).toContain("BRAIN_OPUS");
    expect(SUB_METERS).toContain("TTS_CARTESIA");
    expect(SUB_METERS).toContain("FACT_RECALL");
  });
});
