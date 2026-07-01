import { describe, it, expect } from "vitest";
import { planMcpAdd, mcpCollection } from "../controls/mcp";

describe("manage/mcp planMcpAdd", () => {
  it("a personal remote connector needs no admin", () => {
    expect(planMcpAdd({ scope: "user" })).toEqual({ transport: "http", scope: "user", needsAdmin: false });
  });
  it("defaults to a personal remote connector when scope is omitted", () => {
    expect(planMcpAdd({})).toEqual({ transport: "http", scope: "user", needsAdmin: false });
  });
  it("an org connector requires admin and maps org→system", () => {
    expect(planMcpAdd({ scope: "org" })).toEqual({ transport: "http", scope: "system", needsAdmin: true });
  });
  it("a local (stdio) connector requires admin even at user scope", () => {
    expect(planMcpAdd({ scope: "user", command: "npx foo" })).toEqual({ transport: "stdio", scope: "user", needsAdmin: true });
  });
});

describe("manage/mcp addSchema", () => {
  const schema = mcpCollection.addSchema!;
  it("accepts a remote connector with a url", () => {
    expect(schema.safeParse({ name: "grok", url: "https://api.x.ai/mcp" }).success).toBe(true);
  });
  it("accepts a local connector with a command", () => {
    expect(schema.safeParse({ name: "fs", command: "npx server" }).success).toBe(true);
  });
  it("rejects a connector with NEITHER url nor command", () => {
    expect(schema.safeParse({ name: "x" }).success).toBe(false);
  });
  it("rejects a connector with BOTH url and command", () => {
    expect(schema.safeParse({ name: "x", url: "https://a.b", command: "npx y" }).success).toBe(false);
  });
});
