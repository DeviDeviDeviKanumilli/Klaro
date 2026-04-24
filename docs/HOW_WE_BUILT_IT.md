# How we built Klaro

Klaro is a **voice-first AI assistant** that listens over the mic, reasons with a **LangGraph supervisor**, can drive a **real browser** for commerce and automation, and speaks back with **low-latency streaming audio**. This document is the hackathon-friendly story of how we put it together.

---

## 1. What we set out to build

We wanted an assistant that feels like a conversation—not a chat box—so the stack is built around:

- **Continuous audio in** (speech-to-text) and **streaming audio out** (text-to-speech).
- **Interruptibility**: if the user talks while the agent is speaking, we cancel in-flight work and start fresh.
- **Specialists, not one giant prompt**: a router sends work to commerce, general, coding, desktop, or documentation agents as needed.
- **Visible automation**: browser control goes through **Stagehand** on **Chromium**, so demos stay inspectable.

The mental model we used internally is **Ears → Brain → Hands → Mouth** (see `architecture.txt`).

---

## 2. Monorepo layout

| Package | Role |
|--------|------|
| **`server/`** | Express + Socket.io orchestrator, LangGraph supervisor, STT/TTS plumbing, Stagehand singleton, Vitest tests. |
| **`electron/`** | Desktop shell (Vite + React), liquid-glass UI, connects to the server over Socket.io. Can optionally spawn the embedded server. |
| **`client/`** | Optional **Next.js** web client for the same voice flow. |
| **`gemma-native-llm/`** | Small experimental area for local / Gemini-style LLM calls. |
| **`agentverse/`** | Python adapter utilities for Agentverse-style registration (sidecar to the main Node stack). |

Root `package.json` mainly wires **`npm run test`** to the server test suite.

---

## 3. The server: orchestrator + real-time voice

We use **Node.js (ESM)**, **Express**, and **Socket.io** for a single long-lived connection per session. That matters because:

- Voice status (`listening` → `thinking` → `speaking`) and **audio chunks** are pushed over the same channel.
- We can **abort** the current LLM/TTS pipeline when the user barges in.

The **`VoicePipeline`** (`server/src/pipeline/voicePipeline.ts`) ties together:

- An **LLM provider** abstraction (`server/src/llm/`) for streaming where applicable.
- A **TTS provider** (`server/src/tts/`) with **chunked synthesis** and separate “interim” phrases so the UI can hear short progress cues without blocking the main reply.
- **AbortController**-style cancellation so new user input doesn’t stack on old audio.

Speech-to-text is integrated so live audio can be turned into text before the supervisor runs (exact provider is configured via env; see `server/.env.example`).

---

## 4. LangGraph supervisor: classify, route, respond

The **supervisor** (`server/src/agents/supervisor.ts`) is a **LangGraph** `StateGraph`. It:

1. **Classifies intent** quickly (e.g. shopping vs. chit-chat vs. coding).
2. **Routes** to a specialist **Commerce**, **General**, or other agent modules under `server/src/agents/`.
3. **Formats** the reply for voice (strip markdown, shorten URLs, avoid list-heavy output that sounds bad when read aloud).

The contract between the socket layer and the graph is documented in `docs/03-langgraph-supervisor.md`: structured inputs (user text, conversation history, optional **user profile**, optional **page snapshot**) and a single **TTS-ready** `responseText` plus **agent category** for telemetry and UX.

---

## 5. Specialist agents and tools

Under `server/src/agents/` we keep **isolated** modules—e.g. **commerce**, **general**, **coding**, **desktop**, **documentation**—so prompts and tools stay maintainable. Shared tool wiring lives in `tools.ts`.

**Desktop** and advanced flows can use **Anthropic** APIs where we need computer-use or console-style capabilities; keys and options are documented in `.env.example`.

---

## 6. The “hands”: Stagehand + browser

For anything that needs to **see or click the web**, we use **Stagehand** (`@browserbasehq/stagehand`) with a **visible Chromium** instance managed as a **singleton** (`server/src/lib/stagehand.ts`). High-level intents from the agents become concrete browser actions; judges can watch the session like a ghost user.

---

## 7. Knowledge and memory

We support a **local SQLite + FTS** knowledge base when `SQLITE_KB_PATH` is set, with optional **Elasticsearch** for broader retrieval (`server/src/lib/sqliteKnowledgeBase.ts`, `elasticsearch.ts`). A **seed user profile** (`server/data/seed-user-profile.json`) gives the supervisor realistic prefs (budget, stores, accessibility) for demos.

---

## 8. Clients: Electron and Next.js

- **Electron** (`electron/`): React 19 + Vite, **Tailwind**, **liquid-glass-react**, **Socket.io client**. Mic capture, transcript UI, and audio playback hooks mirror the web client patterns.
- **Client** (`client/`): **Next.js 16** App Router + Socket.io for a browser-only path.

Both are intentionally **thin**: they stream events and audio; heavy logic stays on the server.

---

## 9. Quality: tests and guardrails

The server uses **Vitest** and **Supertest** for API/socket chokepoint tests (`*.test.ts`, `*.integration.test.ts`). Routing, auth helpers, formatters, and supervisor edge cases get regression coverage so refactors during the hackathon don’t break the demo.

---

## 10. How to run it (recap)

1. Copy `server/.env.example` → `server/.env` and add keys.
2. `cd server && npm install && npm run dev` (default port **3001**).
3. `cd electron && npm install && npm run dev` (or `cd client && npm run dev` for the web app).

Health check: `GET /health` on the server.

---

## 11. What we’d do next

- Harden **observability** (structured logs, trace IDs per session).
- Expand **evals** for supervisor routing and voice formatting.
- Productize **deployment** (single binary or hosted server + pinned browser).

---

*For layer-by-layer API notes, see the rest of the [`docs/`](.) folder. For the one-page “organs” diagram, see `architecture.txt` at the repo root.*
