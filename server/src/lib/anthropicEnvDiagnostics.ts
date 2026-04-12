import { normalizeAnthropicApiKey } from "./anthropicComputerUse.js";

/**
 * Safe startup hints for Anthropic auth (no secret values logged).
 */
export function logAnthropicStartupHints(): void {
  if (process.env.ANTHROPIC_AUTH_TOKEN?.trim()) {
    console.warn(
      "[Server] ANTHROPIC_AUTH_TOKEN is set (Bearer auth). If you only use ANTHROPIC_API_KEY, unset ANTHROPIC_AUTH_TOKEN to avoid conflicting auth headers.",
    );
  }

  const raw = process.env.ANTHROPIC_API_KEY;
  const hadBom =
    typeof raw === "string" && raw.length > 0 && raw.charCodeAt(0) === 0xfeff;
  const key = normalizeAnthropicApiKey(raw);
  if (!key) {
    if (raw !== undefined && String(raw).replace(/^\uFEFF/, "").trim() === "") {
      console.warn(
        "[Server] ANTHROPIC_API_KEY is set but empty/whitespace-only after trim — API will 401.",
      );
    }
    return;
  }

  if (hadBom) {
    console.warn(
      "[Server] Stripped UTF-8 BOM from ANTHROPIC_API_KEY (use UTF-8 without BOM in server/.env).",
    );
  }

  const expectedPrefix = "sk-ant-api";
  const prefixOk = key.startsWith(expectedPrefix);
  console.log(
    `[Server] Anthropic API key: length=${key.length} prefix_ok=${prefixOk} first_char_code=${key.charCodeAt(0)}`,
  );
  if (!prefixOk) {
    console.warn(
      `[Server] Anthropic API key does not start with "${expectedPrefix}" — verify it is a Console API key.`,
    );
  }
  const baseRaw =
    process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com";
  try {
    const host = new URL(baseRaw).hostname;
    if (host !== "api.anthropic.com") {
      console.warn(
        `[Server] ANTHROPIC_BASE_URL host is "${host}" — requests do NOT go to Anthropic's API. A Console API key will return 401 here. For direct Anthropic, unset ANTHROPIC_BASE_URL (shell + server/.env) so the default https://api.anthropic.com is used.`,
      );
    } else {
      console.log(`[Server] Anthropic API host: ${host}`);
    }
  } catch {
    console.warn(
      `[Server] ANTHROPIC_BASE_URL is not a valid URL: ${baseRaw.slice(0, 40)}…`,
    );
  }
  if (process.env.ANTHROPIC_DEBUG === "1" || process.env.ANTHROPIC_DEBUG === "true") {
    console.log(
      "[Server] ANTHROPIC_DEBUG is on — request URL and header sizes log to stderr on each Anthropic call.",
    );
  }
}
