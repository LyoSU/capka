import { describe, it, expect } from "vitest";
import { buildRegistry } from "../controls";

describe("manage/controls", () => {
  const reg = buildRegistry();

  it("registers the personal and org controls", () => {
    expect(reg.get("user.locale")).toBeTruthy();
    expect(reg.get("user.timezone")).toBeTruthy();
    expect(reg.get("org.sandbox_network")).toBeTruthy();
  });

  it("SECURITY: every org-scope control is admin-only, every user-scope control is user-role", () => {
    for (const c of reg.all()) {
      if (c.scope === "org") expect(c.requiredRole, `${c.id} must be admin`).toBe("admin");
      if (c.scope === "user") expect(c.requiredRole, `${c.id} must be user`).toBe("user");
    }
  });

  it("SECURITY: no org mutation applies without confirmation", () => {
    for (const c of reg.all()) {
      if (c.scope === "org") expect(c.risk, `${c.id} must require confirm`).toBe("confirm");
    }
  });

  it("locale control accepts a supported locale and rejects an unknown one", () => {
    const locale = reg.get("user.locale")!;
    expect(locale.schema.safeParse("uk").success).toBe(true);
    expect(locale.schema.safeParse("de").success).toBe(false);
  });

  it("sandbox_network control accepts a valid mode and rejects garbage", () => {
    const net = reg.get("org.sandbox_network")!;
    expect(net.schema.safeParse("bridge").success).toBe(true);
    expect(net.schema.safeParse("wifi").success).toBe(false);
  });

  it("boolean controls render true/false as human words", () => {
    const b = reg.get("org.sandbox_enabled")!;
    expect(b.format?.("true")).toBe("Увімкнено");
    expect(b.format?.("false")).toBe("Вимкнено");
  });
});
