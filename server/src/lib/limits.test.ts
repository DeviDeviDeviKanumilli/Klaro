import { describe, expect, it } from "vitest";
import {
  MAX_CONVERSATION_TURNS,
  MAX_RESTORE_SESSION_ID_LEN,
  MAX_STT_SESSION_BYTES,
  MAX_USER_MESSAGE_CHARS,
} from "./limits.js";

describe("limits", () => {
  it("exports expected caps", () => {
    expect(MAX_USER_MESSAGE_CHARS).toBe(32_000);
    expect(MAX_CONVERSATION_TURNS).toBe(400);
    expect(MAX_STT_SESSION_BYTES).toBe(30 * 1024 * 1024);
    expect(MAX_RESTORE_SESSION_ID_LEN).toBe(256);
  });
});
