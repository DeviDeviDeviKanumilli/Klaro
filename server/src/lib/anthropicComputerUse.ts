import Anthropic, { APIError } from "@anthropic-ai/sdk";

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_BETA = "computer-use-2025-11-24";

export type ComputerUseToolType = "computer_20250124" | "computer_20251124";

/**
 * Normalize Console API key from env: strip UTF-8 BOM, trim, treat empty as missing.
 * Important: `value?.trim() ?? null` is wrong for "" — empty string is not nullish, so the SDK
 * would send `X-Api-Key:` empty and Anthropic returns 401 "Invalid token".
 */
export function normalizeAnthropicApiKey(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const stripped = raw.replace(/^\uFEFF/, "").trim();
  if (stripped.length === 0) return null;
  return stripped;
}

function anthropicDebugFetch(): typeof fetch | undefined {
  const on =
    process.env.ANTHROPIC_DEBUG === "1" || process.env.ANTHROPIC_DEBUG === "true";
  if (!on) return undefined;

  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const h = new Headers(init?.headers);
    const xk = h.get("x-api-key") ?? h.get("X-Api-Key");
    const auth = h.get("authorization") ?? h.get("Authorization");
    console.log(`[Anthropic DEBUG] ${init?.method ?? "GET"} ${url}`);
    console.log(
      `[Anthropic DEBUG] X-Api-Key present=${Boolean(xk)} utf8_bytes=${xk ? Buffer.byteLength(xk, "utf8") : 0} Authorization=${auth ? "present" : "absent"}`,
    );
    return fetch(input, init as RequestInit);
  };
}

/**
 * Desktop + documentation agents: API key only (no ANTHROPIC_AUTH_TOKEN Bearer),
 * and default API host unless ANTHROPIC_BASE_URL is set.
 */
export function createAnthropicClient(): Anthropic {
  const apiKey = normalizeAnthropicApiKey(process.env.ANTHROPIC_API_KEY);
  const fetchDbg = anthropicDebugFetch();
  return new Anthropic({
    apiKey,
    authToken: null,
    baseURL:
      process.env.ANTHROPIC_BASE_URL?.trim() || DEFAULT_ANTHROPIC_BASE_URL,
    ...(fetchDbg ? { fetch: fetchDbg } : {}),
  });
}

/**
 * Model + beta + tool schema for Anthropic computer use (desktop + documentation agents).
 * Defaults: Sonnet 4.6 + `computer-use-2025-11-24` + `computer_20251124`.
 * Pair `computer-use-2025-01-24` with `computer_20250124` (e.g. Sonnet 4.5);
 * `computer-use-2025-11-24` with `computer_20251124` (Sonnet 4.6, Opus 4.6, etc.).
 */
export function getAnthropicComputerUseConfig(): {
  model: string;
  betas: string[];
  toolType: ComputerUseToolType;
} {
  const model = (process.env.ANTHROPIC_COMPUTER_USE_MODEL || DEFAULT_MODEL).trim();
  const beta = (process.env.ANTHROPIC_COMPUTER_USE_BETA || DEFAULT_BETA).trim();
  const toolType: ComputerUseToolType = beta.includes("2025-11-24")
    ? "computer_20251124"
    : "computer_20250124";
  return {
    model,
    betas: [beta],
    toolType,
  };
}

/** Operator-facing log for failed `anthropic.beta.messages.create` calls (no secrets). */
export function logAnthropicApiError(prefix: string, err: unknown): void {
  if (err instanceof APIError) {
    console.error(
      `${prefix} [Anthropic HTTP ${err.status ?? "?"}] ${err.constructor.name} request_id=${err.requestID ?? "n/a"}: ${err.message}`,
    );
    if (err.status === 401) {
      console.error(`${prefix} hint: invalid or missing ANTHROPIC_API_KEY for this API (not the Claude.ai web subscription).`);
    } else if (err.status === 403) {
      console.error(`${prefix} hint: permission denied — check org access / model allowlist for computer use.`);
    } else if (err.status === 429) {
      console.error(`${prefix} hint: rate limited — retry later or check Anthropic limits.`);
    }
    return;
  }
  console.error(`${prefix} API error:`, err);
}
