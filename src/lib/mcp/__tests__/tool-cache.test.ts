import { describe, it, expect, beforeEach } from "vitest";
import { getCachedTools, setCachedTools, clearCachedTools } from "../tool-cache";

const tools = [{ name: "scan", description: "scan", inputSchema: { type: "object", properties: {} } }];

describe("mcp tool-cache", () => {
  beforeEach(() => clearCachedTools("srv"));

  it("returns undefined for an unknown server", () => {
    expect(getCachedTools("srv")).toBeUndefined();
  });

  it("stores and returns a server's tool schemas", () => {
    setCachedTools("srv", tools);
    expect(getCachedTools("srv")).toEqual(tools);
  });

  it("clears a server's cached tools", () => {
    setCachedTools("srv", tools);
    clearCachedTools("srv");
    expect(getCachedTools("srv")).toBeUndefined();
  });
});
