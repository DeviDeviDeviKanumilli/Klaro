import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeSqliteKnowledgeBase,
  createSqliteKnowledgeBase,
} from "./sqliteKnowledgeBase.js";
import type { PageVisit } from "../types/index.js";

describe("SQLite KnowledgeBase integration", () => {
  let dbPath: string;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "klaro-sqlite-test-"));
    dbPath = join(tmpDir, "kb.db");
  });

  afterAll(() => {
    closeSqliteKnowledgeBase();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("indexes and restores conversation in order", async () => {
    closeSqliteKnowledgeBase();
    const kb = createSqliteKnowledgeBase(dbPath);
    const sid = "session-abc";
    await kb.indexConversation({
      sessionId: sid,
      role: "user",
      text: "first",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    await kb.indexConversation({
      sessionId: sid,
      role: "assistant",
      text: "second",
      timestamp: "2026-01-01T00:00:01.000Z",
    });
    const restored = await kb.restoreConversation(sid, 50);
    expect(restored.map((e) => e.text)).toEqual(["first", "second"]);
  });

  it("FTS search finds indexed page visit", async () => {
    closeSqliteKnowledgeBase();
    const kb = createSqliteKnowledgeBase(dbPath);
    const visit: PageVisit = {
      sessionId: "s1",
      url: "https://example.com/p",
      title: "Unique Otter Page",
      content: "River otters swim in rivers.",
      userQuery: "otters",
      agentCategory: "general",
      timestamp: "2026-01-02T00:00:00.000Z",
    };
    await kb.indexPageVisit(visit);
    const hits = await kb.searchBrowsingHistory("otter", "s1", 5);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].title).toContain("Otter");
  });

  it("indexes products and searchProductsViewed respects session filter", async () => {
    closeSqliteKnowledgeBase();
    const kb = createSqliteKnowledgeBase(dbPath);
    await kb.indexProductViewed({
      sessionId: "sess-prod-a",
      url: "https://shop.example/a",
      title: "Widget listing",
      name: "Acme Titanium Widget",
      price: "99",
      store: "AcmeMart",
      timestamp: "2026-01-03T00:00:00.000Z",
    });
    await kb.indexProductViewed({
      sessionId: "sess-prod-b",
      url: "https://shop.example/b",
      title: "Other",
      name: "Acme Titanium Widget clone",
      price: "1",
      store: "OtherStore",
      timestamp: "2026-01-03T00:01:00.000Z",
    });
    const forA = await kb.searchProductsViewed("titanium", "sess-prod-a", 5);
    expect(forA.length).toBeGreaterThanOrEqual(1);
    expect(forA.every((p) => p.sessionId === "sess-prod-a")).toBe(true);
    expect(forA[0].name).toMatch(/Titanium/);
  });

  it("updatePreference and getProfile round-trip for a session", async () => {
    closeSqliteKnowledgeBase();
    const kb = createSqliteKnowledgeBase(dbPath);
    const sid = "sess-prefs-xyz";
    await kb.updatePreference(sid, "budget", "under-200");
    const profile = await kb.getProfile(sid);
    expect(profile).not.toBeNull();
    expect(profile!.preferences.budget).toBe("under-200");
  });

  it("fetchMemoryContext returns non-empty string when pages, products, and chat match", async () => {
    closeSqliteKnowledgeBase();
    const kb = createSqliteKnowledgeBase(dbPath);
    const sid = "sess-memory-fts";
    await kb.indexPageVisit({
      sessionId: sid,
      url: "https://example.com/velvet",
      title: "Velvet curtains guide",
      content: "Velvet fabric care and velvet drapes.",
      userQuery: "velvet",
      agentCategory: "general",
      timestamp: "2026-01-04T00:00:00.000Z",
    });
    await kb.indexProductViewed({
      sessionId: sid,
      url: "https://shop.example/velvet-shoes",
      title: "Shoes",
      name: "Velvet loafers deluxe",
      price: "120",
      store: "ShoeCo",
      timestamp: "2026-01-04T00:01:00.000Z",
    });
    await kb.indexConversation({
      sessionId: sid,
      role: "user",
      text: "I love velvet texture for winter outfits",
      timestamp: "2026-01-04T00:02:00.000Z",
    });
    const ctx = await kb.fetchMemoryContext("velvet", sid);
    expect(ctx.length).toBeGreaterThan(0);
    expect(ctx).toMatch(/Previously visited pages/i);
    expect(ctx).toMatch(/Previously viewed products/i);
    expect(ctx).toMatch(/Related earlier conversation/i);
  });
});
