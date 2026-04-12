/** Parse comma-separated ALLOWED_ORIGINS env value. */

export function parseAllowedOriginsList(
  envValue: string | undefined,
): string[] {
  const raw = envValue?.trim();
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
