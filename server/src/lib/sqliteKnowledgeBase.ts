import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type {
  ConversationEntry,
  KnowledgeBase,
  PageVisit,
  ProductViewed,
  UserProfile,
} from "../types/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let sharedDb: Database.Database | null = null;

export function closeSqliteKnowledgeBase(): void {
  if (sharedDb) {
    try {
      sharedDb.close();
    } catch {
      /* ignore */
    }
    sharedDb = null;
  }
}

function loadSeedProfile(): UserProfile | null {
  try {
    const profilePath = join(__dirname, "../../data/seed-user-profile.json");
    return JSON.parse(readFileSync(profilePath, "utf-8")) as UserProfile;
  } catch {
    return null;
  }
}

/** Strip / tokenize for FTS5 MATCH — avoids syntax errors from punctuation. */
export function ftsMatchQuery(raw: string): string | null {
  const tokens = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12);
  if (tokens.length === 0) return null;
  return tokens
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" OR ");
}

function migrate(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      session_id TEXT PRIMARY KEY NOT NULL,
      profile_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS browsing_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      user_query TEXT,
      agent_category TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS browsing_history_fts USING fts5(
      title,
      content,
      user_query,
      content='browsing_history',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS browsing_history_ai AFTER INSERT ON browsing_history BEGIN
      INSERT INTO browsing_history_fts(rowid, title, content, user_query)
      VALUES (new.id, new.title, new.content, COALESCE(new.user_query, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS browsing_history_ad AFTER DELETE ON browsing_history BEGIN
      INSERT INTO browsing_history_fts(browsing_history_fts, rowid, title, content, user_query)
      VALUES('delete', old.id, old.title, old.content, COALESCE(old.user_query, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS browsing_history_au AFTER UPDATE ON browsing_history BEGIN
      INSERT INTO browsing_history_fts(browsing_history_fts, rowid, title, content, user_query)
      VALUES('delete', old.id, old.title, old.content, COALESCE(old.user_query, ''));
      INSERT INTO browsing_history_fts(rowid, title, content, user_query)
      VALUES (new.id, new.title, new.content, COALESCE(new.user_query, ''));
    END;

    CREATE TABLE IF NOT EXISTS products_viewed (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      name TEXT NOT NULL,
      price TEXT,
      rating TEXT,
      store TEXT,
      timestamp TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS products_viewed_fts USING fts5(
      title,
      name,
      store,
      content='products_viewed',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS products_viewed_ai AFTER INSERT ON products_viewed BEGIN
      INSERT INTO products_viewed_fts(rowid, title, name, store)
      VALUES (new.id, new.title, new.name, COALESCE(new.store, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS products_viewed_ad AFTER DELETE ON products_viewed BEGIN
      INSERT INTO products_viewed_fts(products_viewed_fts, rowid, title, name, store)
      VALUES('delete', old.id, old.title, old.name, COALESCE(old.store, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS products_viewed_au AFTER UPDATE ON products_viewed BEGIN
      INSERT INTO products_viewed_fts(products_viewed_fts, rowid, title, name, store)
      VALUES('delete', old.id, old.title, old.name, COALESCE(old.store, ''));
      INSERT INTO products_viewed_fts(rowid, title, name, store)
      VALUES (new.id, new.title, new.name, COALESCE(new.store, ''));
    END;

    CREATE TABLE IF NOT EXISTS conversation_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      agent_category TEXT,
      timestamp TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS conversation_history_fts USING fts5(
      text,
      content='conversation_history',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS conversation_history_ai AFTER INSERT ON conversation_history BEGIN
      INSERT INTO conversation_history_fts(rowid, text) VALUES (new.id, new.text);
    END;

    CREATE TRIGGER IF NOT EXISTS conversation_history_ad AFTER DELETE ON conversation_history BEGIN
      INSERT INTO conversation_history_fts(conversation_history_fts, rowid, text)
      VALUES('delete', old.id, old.text);
    END;

    CREATE TRIGGER IF NOT EXISTS conversation_history_au AFTER UPDATE ON conversation_history BEGIN
      INSERT INTO conversation_history_fts(conversation_history_fts, rowid, text)
      VALUES('delete', old.id, old.text);
      INSERT INTO conversation_history_fts(rowid, text) VALUES (new.id, new.text);
    END;

    CREATE INDEX IF NOT EXISTS idx_browsing_session ON browsing_history(session_id);
    CREATE INDEX IF NOT EXISTS idx_products_session ON products_viewed(session_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_session ON conversation_history(session_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_ts ON conversation_history(session_id, timestamp);
  `);
}

type BrowsingRow = {
  id: number;
  session_id: string;
  url: string;
  title: string;
  content: string;
  user_query: string | null;
  agent_category: string;
  timestamp: string;
};

type ProductRow = {
  id: number;
  session_id: string;
  url: string;
  title: string;
  name: string;
  price: string | null;
  rating: string | null;
  store: string | null;
  timestamp: string;
};

type ConvRow = {
  id: number;
  session_id: string;
  role: string;
  text: string;
  agent_category: string | null;
  timestamp: string;
};

function rowToPageVisit(r: BrowsingRow): PageVisit {
  return {
    url: r.url,
    title: r.title,
    content: r.content,
    sessionId: r.session_id,
    userQuery: r.user_query ?? undefined,
    agentCategory: r.agent_category as PageVisit["agentCategory"],
    timestamp: r.timestamp,
  };
}

function rowToProduct(r: ProductRow): ProductViewed {
  return {
    url: r.url,
    title: r.title,
    name: r.name,
    price: r.price ?? undefined,
    rating: r.rating ?? undefined,
    store: r.store ?? undefined,
    sessionId: r.session_id,
    timestamp: r.timestamp,
  };
}

function rowToConversation(r: ConvRow): ConversationEntry {
  return {
    sessionId: r.session_id,
    role: r.role as ConversationEntry["role"],
    text: r.text,
    agentCategory: (r.agent_category ?? undefined) as
      | ConversationEntry["agentCategory"]
      | undefined,
    timestamp: r.timestamp,
  };
}

/**
 * Local knowledge base using SQLite + FTS5 (no Elasticsearch).
 * Paths are relative to server `process.cwd()` unless absolute.
 */
export function createSqliteKnowledgeBase(dbFilePath: string): KnowledgeBase {
  const resolved =
    dbFilePath === ":memory:" || dbFilePath.startsWith("file:")
      ? dbFilePath
      : dbFilePath.startsWith("/") || /^[A-Za-z]:\\/.test(dbFilePath)
        ? dbFilePath
        : join(process.cwd(), dbFilePath);

  if (resolved !== ":memory:") {
    mkdirSync(dirname(resolved), { recursive: true });
  }

  closeSqliteKnowledgeBase();
  const db = new Database(resolved);
  sharedDb = db;
  migrate(db);

  const seedProfile = loadSeedProfile();

  const insertPage = db.prepare(`
    INSERT INTO browsing_history (session_id, url, title, content, user_query, agent_category, timestamp)
    VALUES (@sessionId, @url, @title, @content, @userQuery, @agentCategory, @timestamp)
  `);

  const insertProduct = db.prepare(`
    INSERT INTO products_viewed (session_id, url, title, name, price, rating, store, timestamp)
    VALUES (@sessionId, @url, @title, @name, @price, @rating, @store, @timestamp)
  `);

  const insertConv = db.prepare(`
    INSERT INTO conversation_history (session_id, role, text, agent_category, timestamp)
    VALUES (@sessionId, @role, @text, @agentCategory, @timestamp)
  `);

  const selectProfile = db.prepare(
    `SELECT profile_json FROM user_profiles WHERE session_id = ?`,
  );

  const upsertProfile = db.prepare(`
    INSERT INTO user_profiles (session_id, profile_json) VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET profile_json = excluded.profile_json
  `);

  return {
    isAvailable(): boolean {
      return true;
    },

    async getProfile(sessionId: string): Promise<UserProfile | null> {
      const row = selectProfile.get(sessionId) as { profile_json: string } | undefined;
      if (row) {
        try {
          return JSON.parse(row.profile_json) as UserProfile;
        } catch {
          return seedProfile;
        }
      }
      return seedProfile;
    },

    async updatePreference(
      sessionId: string,
      key: string,
      value: string,
    ): Promise<void> {
      const base =
        (await this.getProfile(sessionId)) ??
        seedProfile ??
        ({
          name: "User",
          preferences: {
            budget: "",
            currency: "USD",
            preferredStores: "",
          },
        } satisfies UserProfile);

      const next: UserProfile = {
        ...base,
        preferences: {
          ...base.preferences,
          [key]: value,
        },
      };
      upsertProfile.run(sessionId, JSON.stringify(next));
    },

    async indexPageVisit(data: PageVisit): Promise<void> {
      insertPage.run({
        sessionId: data.sessionId,
        url: data.url,
        title: data.title,
        content: data.content,
        userQuery: data.userQuery ?? null,
        agentCategory: data.agentCategory,
        timestamp: data.timestamp,
      });
    },

    async indexProductViewed(data: ProductViewed): Promise<void> {
      insertProduct.run({
        sessionId: data.sessionId,
        url: data.url,
        title: data.title,
        name: data.name,
        price: data.price ?? null,
        rating: data.rating ?? null,
        store: data.store ?? null,
        timestamp: data.timestamp,
      });
    },

    async searchBrowsingHistory(
      query: string,
      sessionId?: string,
      limit = 5,
    ): Promise<PageVisit[]> {
      const q = ftsMatchQuery(query);
      if (!q) return [];

      const sql = `
        SELECT h.*
        FROM browsing_history h
        JOIN browsing_history_fts ON h.id = browsing_history_fts.rowid
        WHERE browsing_history_fts MATCH ?
          AND (? IS NULL OR h.session_id = ?)
        ORDER BY bm25(browsing_history_fts)
        LIMIT ?
      `;
      const rows = db
        .prepare(sql)
        .all(q, sessionId ?? null, sessionId ?? null, limit) as BrowsingRow[];
      return rows.map(rowToPageVisit);
    },

    async searchProductsViewed(
      query: string,
      sessionId?: string,
      limit = 5,
    ): Promise<ProductViewed[]> {
      const q = ftsMatchQuery(query);
      if (!q) return [];

      const sql = `
        SELECT p.*
        FROM products_viewed p
        JOIN products_viewed_fts ON p.id = products_viewed_fts.rowid
        WHERE products_viewed_fts MATCH ?
          AND (? IS NULL OR p.session_id = ?)
        ORDER BY bm25(products_viewed_fts)
        LIMIT ?
      `;
      const rows = db
        .prepare(sql)
        .all(q, sessionId ?? null, sessionId ?? null, limit) as ProductRow[];
      return rows.map(rowToProduct);
    },

    async fetchMemoryContext(
      query: string,
      sessionId?: string,
    ): Promise<string> {
      const [pages, products, conversations] = await Promise.all([
        this.searchBrowsingHistory(query, sessionId, 3),
        this.searchProductsViewed(query, sessionId, 3),
        this.searchConversationHistory(query, sessionId, 3),
      ]);

      const parts: string[] = [];
      if (pages.length > 0) {
        parts.push(
          `Previously visited pages: ${pages.map((p) => `"${p.title}" (${p.url})`).join(", ")}`,
        );
      }
      if (products.length > 0) {
        parts.push(
          `Previously viewed products: ${products
            .map(
              (p) =>
                `${p.name}${p.price ? ` ($${p.price})` : ""}${p.store ? ` at ${p.store}` : ""}`,
            )
            .join(", ")}`,
        );
      }
      if (conversations.length > 0) {
        parts.push(
          `Related earlier conversation: ${conversations
            .map((c) => `${c.role}: "${c.text.slice(0, 100)}"`)
            .join("; ")}`,
        );
      }
      return parts.join(". ");
    },

    async indexConversation(entry: ConversationEntry): Promise<void> {
      insertConv.run({
        sessionId: entry.sessionId,
        role: entry.role,
        text: entry.text,
        agentCategory: entry.agentCategory ?? null,
        timestamp: entry.timestamp,
      });
    },

    async searchConversationHistory(
      query: string,
      sessionId?: string,
      limit = 5,
    ): Promise<ConversationEntry[]> {
      const q = ftsMatchQuery(query);
      if (!q) return [];

      const sql = `
        SELECT c.*
        FROM conversation_history c
        JOIN conversation_history_fts ON c.id = conversation_history_fts.rowid
        WHERE conversation_history_fts MATCH ?
          AND (? IS NULL OR c.session_id = ?)
        ORDER BY bm25(conversation_history_fts)
        LIMIT ?
      `;
      const rows = db
        .prepare(sql)
        .all(q, sessionId ?? null, sessionId ?? null, limit) as ConvRow[];
      return rows.map(rowToConversation);
    },

    async restoreConversation(
      sessionId: string,
      limit = 50,
    ): Promise<ConversationEntry[]> {
      const sql = `
        SELECT id, session_id, role, text, agent_category, timestamp
        FROM conversation_history
        WHERE session_id = ?
        ORDER BY timestamp ASC, id ASC
        LIMIT ?
      `;
      const rows = db.prepare(sql).all(sessionId, limit) as ConvRow[];
      return rows.map(rowToConversation);
    },
  };
}

/** Open SQLite KB when SQLITE_KB_PATH is set; returns null if unset or open fails. */
export function tryCreateSqliteKnowledgeBaseFromEnv(): KnowledgeBase | null {
  const p = process.env.SQLITE_KB_PATH?.trim();
  if (!p) return null;
  try {
    const kb = createSqliteKnowledgeBase(p);
    console.log(`[SQLite KB] Opened database at ${p}`);
    return kb;
  } catch (err) {
    console.warn(
      "[SQLite KB] Failed to open database — knowledge base DISABLED:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
