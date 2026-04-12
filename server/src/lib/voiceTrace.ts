import { appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** NDJSON under `server/voice-trace.ndjson` (next to package.json). */
const VOICE_TRACE_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../voice-trace.ndjson",
);

let announcedPath = false;

export function hasHanScript(s: string): boolean {
  return /[\u4e00-\u9fff]/.test(s);
}

/** Debug voice pipeline; no secrets — short previews only. */
export function voiceTrace(event: string, data: Record<string, unknown>): void {
  if (!announcedPath) {
    announcedPath = true;
    console.log("[VoiceTrace] NDJSON path:", resolve(VOICE_TRACE_FILE));
  }
  const payload = { t: Date.now(), event, ...data };
  try {
    appendFileSync(VOICE_TRACE_FILE, `${JSON.stringify(payload)}\n`);
  } catch {
    /* disk full / permissions */
  }
  const logPayload = { ...data };
  if (typeof logPayload.preview === "string") {
    logPayload.preview = (logPayload.preview as string).slice(0, 80);
  }
  console.log("[VoiceTrace]", event, JSON.stringify(logPayload));
}

export function previewText(s: string, max = 160): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}
