/**
 * Wraps little-endian signed 16-bit PCM in a minimal mono/stereo RIFF WAVE
 * suitable for OpenAI Whisper `audio.transcriptions`.
 */
export function pcm16leToWav(
  pcm: Buffer,
  sampleRate: number,
  channels: number,
): Buffer {
  if (channels < 1 || channels > 8) {
    throw new Error(`pcm16leToWav: channels must be 1–8, got ${channels}`);
  }
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192_000) {
    throw new Error(`pcm16leToWav: unsupported sampleRate ${sampleRate}`);
  }
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  if (pcm.length % blockAlign !== 0) {
    throw new Error(
      `pcm16leToWav: PCM length ${pcm.length} is not a multiple of frame size ${blockAlign}`,
    );
  }

  const bitsPerSample = 16;
  const audioFormat = 1; // PCM
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;
  const subchunk1Size = 16;
  const riffChunkSize = 4 + (8 + subchunk1Size) + (8 + dataSize); // WAVE + fmt + data

  const out = Buffer.alloc(12 + 8 + subchunk1Size + 8 + dataSize);

  // RIFF header
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(riffChunkSize, 4);
  out.write("WAVE", 8, "ascii");

  // fmt subchunk
  let o = 12;
  out.write("fmt ", o, "ascii");
  o += 4;
  out.writeUInt32LE(subchunk1Size, o);
  o += 4;
  out.writeUInt16LE(audioFormat, o);
  o += 2;
  out.writeUInt16LE(channels, o);
  o += 2;
  out.writeUInt32LE(sampleRate, o);
  o += 4;
  out.writeUInt32LE(byteRate, o);
  o += 4;
  out.writeUInt16LE(blockAlign, o);
  o += 2;
  out.writeUInt16LE(bitsPerSample, o);
  o += 2;

  // data subchunk
  out.write("data", o, "ascii");
  o += 4;
  out.writeUInt32LE(dataSize, o);
  o += 4;
  pcm.copy(out, o);

  return out;
}
