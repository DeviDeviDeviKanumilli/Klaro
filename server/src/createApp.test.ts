import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createSupervisor } from "./agents/supervisor.js";

const { runSupervisorMock } = vi.hoisted(() => ({
  runSupervisorMock: vi.fn().mockResolvedValue({
    responseText: "mock reply",
    agentCategory: "general" as const,
    actions: [],
  }),
}));

vi.mock("./agents/supervisor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agents/supervisor.js")>();
  return {
    ...actual,
    runSupervisor: runSupervisorMock,
  };
});

import { createApp } from "./createApp.js";

describe("createApp HTTP chokepoints", () => {
  afterEach(() => {
    runSupervisorMock.mockClear();
  });

  it("GET /health returns ok", async () => {
    const graph = createSupervisor(null, null);
    const app = createApp({
      knowledgeBase: null,
      chatGraph: graph,
      allowedOrigins: [],
      serverApiKey: "",
    });
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("POST /api/chat 400 when message missing", async () => {
    const graph = createSupervisor(null, null);
    const app = createApp({
      knowledgeBase: null,
      chatGraph: graph,
      allowedOrigins: [],
      serverApiKey: "",
    });
    const res = await request(app).post("/api/chat").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message is required/);
    expect(runSupervisorMock).not.toHaveBeenCalled();
  });

  it("POST /api/chat invokes runSupervisor and returns mock body", async () => {
    const graph = createSupervisor(null, null);
    const app = createApp({
      knowledgeBase: null,
      chatGraph: graph,
      allowedOrigins: [],
      serverApiKey: "",
    });
    const res = await request(app).post("/api/chat").send({ message: "hello" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      response: "mock reply",
      agentCategory: "general",
    });
    expect(runSupervisorMock).toHaveBeenCalledOnce();
  });

  it("POST /api/chat 401 without key when serverApiKey set", async () => {
    const graph = createSupervisor(null, null);
    const app = createApp({
      knowledgeBase: null,
      chatGraph: graph,
      allowedOrigins: [],
      serverApiKey: "unit-test-secret",
    });
    const res = await request(app).post("/api/chat").send({ message: "hi" });
    expect(res.status).toBe(401);
    expect(runSupervisorMock).not.toHaveBeenCalled();
  });

  it("POST /api/chat 200 with x-server-api-key when serverApiKey set", async () => {
    const graph = createSupervisor(null, null);
    const app = createApp({
      knowledgeBase: null,
      chatGraph: graph,
      allowedOrigins: [],
      serverApiKey: "unit-test-secret",
    });
    const res = await request(app)
      .post("/api/chat")
      .set("x-server-api-key", "unit-test-secret")
      .send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(res.body.response).toBe("mock reply");
  });
});
