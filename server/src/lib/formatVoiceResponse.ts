/** Strip markdown / URLs / list markers for TTS-friendly text (supervisor formatResponse node). */
export function formatVoiceResponse(text: string): string {
  let out = text;

  out = out.replace(/\*\*(.*?)\*\*/g, "$1");
  out = out.replace(/\*(.*?)\*/g, "$1");
  out = out.replace(/`(.*?)`/g, "$1");

  out = out.replace(/https?:\/\/\S+/g, "");

  out = out.replace(/^[-*•]\s+/gm, "");
  out = out.replace(/^\d+\.\s+/gm, "");

  out = out.replace(/([^.!?])\s*$/gm, "$1.");

  out = out.replace(/\n+/g, " ").replace(/\s{2,}/g, " ").trim();

  return out;
}
