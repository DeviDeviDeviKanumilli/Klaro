import { describe, expect, it } from "vitest";
import { pcm16leToWav } from "./pcmToWav.js";

describe("pcm16leToWav", () => {
  it("builds a valid RIFF WAVE for mono 16kHz s16le", () => {
    // 10 ms @ 16kHz mono = 160 samples = 320 bytes
    const pcm = Buffer.alloc(320);
    for (let i = 0; i < 160; i++) {
      pcm.writeInt16LE(i % 1000, i * 2);
    }
    const wav = pcm16leToWav(pcm, 16_000, 1);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.subarray(12, 16).toString("ascii")).toBe("fmt ");
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // channels
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.subarray(36, 40).toString("ascii")).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(320);
    expect(wav.length).toBe(44 + 320);
    expect(wav.subarray(44).equals(pcm)).toBe(true);
  });

  it("supports stereo", () => {
    const pcm = Buffer.alloc(8); // 2 frames stereo
    const wav = pcm16leToWav(pcm, 48_000, 2);
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.length).toBe(44 + 8);
  });

  it("throws when PCM length is not frame-aligned", () => {
    expect(() => pcm16leToWav(Buffer.alloc(3), 16_000, 1)).toThrow(/not a multiple/);
  });
});
