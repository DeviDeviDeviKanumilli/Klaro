import { describe, expect, it } from "vitest";
import { createSupervisor } from "./supervisor.js";

describe("Supervisor graph chokepoint", () => {
  it("createSupervisor compiles a runnable graph without browser or KB", () => {
    const graph = createSupervisor(null, null);
    expect(graph).toBeDefined();
    expect(typeof graph.invoke).toBe("function");
  });
});
