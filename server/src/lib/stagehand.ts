import { Stagehand } from "@browserbasehq/stagehand";
import type { ZodTypeAny } from "zod";
import os from "os";
import path from "path";
import { existsSync, mkdirSync } from "fs";
import type {
  ExtractResult,
  ActResult,
  ObserveResult,
  NavigateResult,
  ExecutionContext,
} from "../types/index.js";

let instance: Stagehand | null = null;

/** Locate Google Chrome on macOS. Returns the path or null if not found. */
function findChrome(): string | null {
  const chromePath =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(chromePath)) return chromePath;
  return null;
}

const INIT_MAX_RETRIES = 3;
const INIT_RETRY_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Kill orphaned Chrome instances that were launched with the Klaro Chrome profile
 * so a retry gets a clean slate.
 */
async function killOrphanedChromeDebugInstances(): Promise<void> {
  try {
    const { execSync } = await import("child_process");
    const pids = execSync(
      `pgrep -f "klaro-chrome-profile" 2>/dev/null || true`,
      { encoding: "utf-8" },
    ).trim();
    if (pids) {
      for (const pid of pids.split("\n").filter(Boolean)) {
        try { process.kill(Number(pid), "SIGKILL"); } catch { /* already gone */ }
      }
      console.log("[Stagehand] Killed orphaned Chrome debug processes");
      await sleep(1000);
    }
  } catch { /* best-effort */ }
}

/**
 * Initialize Stagehand with a visible browser instance.
 * Prefers Google Chrome with an isolated profile; falls back to bundled Chromium.
 * Retries up to 3 times if the CDP connection is refused.
 * Call once at server startup.
 */
export async function initStagehand(): Promise<void> {
  if (instance) return;

  if (!process.env.OPENAI_API_KEY) {
    console.warn(
      "OPENAI_API_KEY not set — Stagehand browser automation will be unavailable",
    );
    return;
  }

  const chromePath = findChrome();
  const userDataDir = path.join(os.tmpdir(), "klaro-chrome-profile");

  mkdirSync(userDataDir, { recursive: true });

  if (chromePath) {
    console.log("[Stagehand] Using Google Chrome:", chromePath);
  } else {
    console.log("[Stagehand] Google Chrome not found — falling back to bundled Chromium");
  }

  for (let attempt = 1; attempt <= INIT_MAX_RETRIES; attempt++) {
    try {
      const stagehandModel = process.env.STAGEHAND_MODEL || "openai/gpt-4.1-mini";
      console.log(`[Stagehand] Using model: ${stagehandModel}`);
      const stagehand = new Stagehand({
        env: "LOCAL",
        model: {
          modelName: stagehandModel,
          apiKey: process.env.OPENAI_API_KEY,
        },
        localBrowserLaunchOptions: {
          headless: false,
          ...(chromePath ? { executablePath: chromePath } : {}),
          userDataDir,
        },
        verbose: 0,
      });

      await stagehand.init();
      instance = stagehand;
      console.log(
        `[Stagehand] Initialized — visible ${chromePath ? "Chrome" : "Chromium"} running`,
      );
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[Stagehand] Init attempt ${attempt}/${INIT_MAX_RETRIES} failed: ${msg}`,
      );

      if (attempt < INIT_MAX_RETRIES) {
        await killOrphanedChromeDebugInstances();
        console.log(
          `[Stagehand] Retrying in ${INIT_RETRY_DELAY_MS}ms...`,
        );
        await sleep(INIT_RETRY_DELAY_MS);
      } else {
        throw new Error(
          `Stagehand failed after ${INIT_MAX_RETRIES} attempts: ${msg}`,
        );
      }
    }
  }
}

/** Return the singleton Stagehand instance, or null if not initialized. */
export function getStagehand(): Stagehand | null {
  return instance;
}

/** Gracefully close the browser and release resources. */
export async function closeStagehand(): Promise<void> {
  if (!instance) return;
  try {
    await instance.close();
  } catch {
    // best-effort cleanup
  }
  instance = null;
}

const CDP_ERROR_PATTERNS = [
  "CDP", "transport closed", "socket-close", "Target closed",
  "Session closed", "Connection refused", "ECONNREFUSED",
  "Protocol error", "not connected", "page has been closed",
];

function isCdpDead(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return CDP_ERROR_PATTERNS.some((p) => msg.includes(p));
}

let reinitInProgress: Promise<void> | null = null;

async function ensureAlive(): Promise<boolean> {
  if (!instance) return false;
  try {
    const page = instance.context.pages()[0];
    if (!page) throw new Error("no page");
    await page.title();
    return true;
  } catch {
    console.warn("[Stagehand] CDP connection dead — reinitializing browser...");
    instance = null;
    if (!reinitInProgress) {
      reinitInProgress = (async () => {
        try {
          await killOrphanedChromeDebugInstances();
          await initStagehand();
          console.log("[Stagehand] Reinitialized after CDP crash");
        } catch (e) {
          console.error("[Stagehand] Reinit failed:", e instanceof Error ? e.message : e);
        } finally {
          reinitInProgress = null;
        }
      })();
    }
    await reinitInProgress;
    return !!instance;
  }
}

/**
 * Create an ExecutionContext that wraps Stagehand.
 * Every method catches errors and returns a typed result — never throws.
 */
export function createExecutionContext(): ExecutionContext | null {
  if (!instance) return null;

  function sh(): Stagehand {
    if (!instance) throw new Error("Stagehand not available");
    return instance;
  }

  return {
    async extract(
      instruction: string,
      schema?: ZodTypeAny,
    ): Promise<ExtractResult> {
      try {
        await ensureAlive();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = schema
          ? await sh().extract(instruction, schema as any)
          : await sh().extract(instruction);
        return {
          success: true,
          data: (typeof result === "object" ? result : { extraction: result }) as Record<string, unknown>,
        };
      } catch (err) {
        if (isCdpDead(err)) {
          await ensureAlive();
          return { success: false, data: null, error: "Browser reconnecting — please try again." };
        }
        return {
          success: false,
          data: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async act(instruction: string): Promise<ActResult> {
      const MAX_RETRIES = 3;

      async function attemptAct(): Promise<ActResult> {
        try {
          await ensureAlive();
          const stagehand = sh();
          const result = await stagehand.act(instruction);
          const page = stagehand.context.pages()[0];
          return {
            success: result.success,
            description: result.actionDescription || result.message,
            newUrl: page?.url() ?? undefined,
          };
        } catch (err) {
          if (isCdpDead(err)) {
            await ensureAlive();
            return { success: false, description: "", error: "Browser reconnecting — please try again." };
          }
          return {
            success: false,
            description: "",
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const result = await attemptAct();
        if (result.success) return result;

        if (attempt < MAX_RETRIES) {
          console.log(`[stagehand] act() attempt ${attempt} failed, scrolling down and retrying...`);
          try {
            const page = sh().context.pages()[0];
            if (page) {
              await page.evaluate(() => window.scrollBy(0, 400));
              await new Promise((r) => setTimeout(r, 500));
            }
          } catch {
            // scroll failed — still retry
          }
        } else {
          console.log(`[stagehand] act() failed after ${MAX_RETRIES} attempts: ${result.error}`);
          return result;
        }
      }

      return { success: false, description: "", error: "Max retries exceeded" };
    },

    async observe(instruction?: string): Promise<ObserveResult> {
      try {
        await ensureAlive();
        const actions = instruction
          ? await sh().observe(instruction)
          : await sh().observe();
        return {
          success: true,
          actions: actions.map((a) => ({
            description: a.description,
            selector: a.selector,
            method: a.method,
          })),
        };
      } catch (err) {
        if (isCdpDead(err)) {
          await ensureAlive();
          return { success: false, actions: [], error: "Browser reconnecting — please try again." };
        }
        return {
          success: false,
          actions: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async navigate(url: string): Promise<NavigateResult> {
      try {
        await ensureAlive();
        const page = sh().context.pages()[0];
        if (!page) {
          return { success: false, finalUrl: "", pageTitle: "", error: "No browser page available" };
        }
        console.log(`[Stagehand] Navigating to: ${url}`);
        await page.goto(url, { waitUntil: "domcontentloaded", timeoutMs: 15000 });
        const finalUrl = page.url();
        const title = await page.title();
        console.log(`[stagehand] navigation complete: ${title} (${finalUrl})`);
        return { success: true, finalUrl, pageTitle: title };
      } catch (err) {
        if (isCdpDead(err)) {
          console.warn("[Stagehand] CDP dead during navigate — reinitializing...");
          const alive = await ensureAlive();
          if (alive) {
            try {
              const page = sh().context.pages()[0];
              if (page) {
                await page.goto(url, { waitUntil: "domcontentloaded", timeoutMs: 15000 });
                return { success: true, finalUrl: page.url(), pageTitle: await page.title() };
              }
            } catch { /* retry also failed */ }
          }
          return { success: false, finalUrl: "", pageTitle: "", error: "Browser reconnected — please try again." };
        }
        console.warn(`[Stagehand] Navigation error for ${url}:`, err instanceof Error ? err.message : err);
        return {
          success: false, finalUrl: "", pageTitle: "",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
