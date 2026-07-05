import { describe, expect, it } from "vitest";
import {
  missingRequiredVnptConfig,
  validateRequiredVnptConfig,
} from "../src/config.js";

const SMARTBOT = {
  SB_BOT_ID: "bot",
  SB_ACCESS_TOKEN: "secret",
  SB_TOKEN_ID: "id",
  SB_TOKEN_KEY: "key",
};

describe("VNPT runtime config validation", () => {
  it("accepts dedicated STT and TTS credentials", () => {
    const env = {
      ...SMARTBOT,
      STT_ACCESS_TOKEN: "stt-secret",
      STT_TOKEN_ID: "stt-id",
      STT_TOKEN_KEY: "stt-key",
      TTS_ACCESS_TOKEN: "tts-secret",
      TTS_TOKEN_ID: "tts-id",
      TTS_TOKEN_KEY: "tts-key",
    };
    expect(missingRequiredVnptConfig(env)).toEqual([]);
    expect(() => validateRequiredVnptConfig(env)).not.toThrow();
  });

  it("accepts the shared SmartVoice fallback credentials", () => {
    const env = {
      ...SMARTBOT,
      SV_ACCESS_TOKEN: "voice-secret",
      SV_TOKEN_ID: "voice-id",
      SV_TOKEN_KEY: "voice-key",
    };
    expect(missingRequiredVnptConfig(env)).toEqual([]);
  });

  it("reports variable names without exposing configured values", () => {
    const env = { ...SMARTBOT, SB_ACCESS_TOKEN: "do-not-print" };
    expect(() => validateRequiredVnptConfig(env)).toThrowError(
      /STT_ACCESS_TOKEN \(or SV_ACCESS_TOKEN\)/,
    );
    try {
      validateRequiredVnptConfig(env);
    } catch (error) {
      expect(error.code).toBe("MISSING_VNPT_CONFIG");
      expect(error.message).not.toContain("do-not-print");
    }
  });
});
