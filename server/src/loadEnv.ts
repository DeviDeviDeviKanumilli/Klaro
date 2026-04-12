/**
 * Load `server/.env` from this package root, not `process.cwd()`.
 * Ensures the same keys when `tsx` is started from the monorepo root or an IDE.
 */
import { config } from "dotenv";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ENV_PATH = path.resolve(here, "../.env");

const result = config({ path: SERVER_ENV_PATH, override: true });

const exists = existsSync(SERVER_ENV_PATH);
const keyCount = result.parsed ? Object.keys(result.parsed).length : 0;
const anthropicRaw = result.parsed?.ANTHROPIC_API_KEY;
const anthropicEmptyInFile =
  anthropicRaw !== undefined && String(anthropicRaw).trim() === "";

console.log(
  `[loadEnv] path=${SERVER_ENV_PATH} exists=${exists} vars_from_file=${keyCount}`,
);

if (result.error) {
  console.warn(`[loadEnv] read error: ${result.error.message}`);
}
if (anthropicEmptyInFile) {
  console.warn(
    "[loadEnv] ANTHROPIC_API_KEY is present in server/.env but empty — requests will 401 until set.",
  );
}
