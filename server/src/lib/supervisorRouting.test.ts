import { describe, expect, it } from "vitest";
import { routeAgentNodeFromCategory } from "./supervisorRouting.js";

describe("routeAgentNodeFromCategory", () => {
  it("routes known categories", () => {
    expect(routeAgentNodeFromCategory("commerce")).toBe("commerceAgent");
    expect(routeAgentNodeFromCategory("coding")).toBe("codingAgent");
    expect(routeAgentNodeFromCategory("desktop")).toBe("desktopAgent");
    expect(routeAgentNodeFromCategory("documentation")).toBe(
      "documentationAgent",
    );
    expect(routeAgentNodeFromCategory("general")).toBe("generalAgent");
  });

  it("defaults unknown to generalAgent", () => {
    expect(routeAgentNodeFromCategory("")).toBe("generalAgent");
    expect(routeAgentNodeFromCategory("bogus")).toBe("generalAgent");
  });
});
