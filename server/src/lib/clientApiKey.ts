/**
 * Read shared-secret API key from Express-style request headers.
 */
export function getClientProvidedServerKey(
  header: (name: string) => string | undefined,
): string | undefined {
  const h = header("x-server-api-key");
  if (h) return h;
  const auth = header("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  return undefined;
}
