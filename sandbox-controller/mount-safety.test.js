import { describe, it, expect } from "vitest";
import { validateMountPath } from "./mount-safety.js";

const opts = { dataRoot: "/data", hostDataRoot: "/opt/capka/data", allowRoots: [] };

describe("validateMountPath", () => {
  it("accepts a plain absolute path", () => {
    expect(validateMountPath("/srv/share", opts)).toEqual({ ok: true, path: "/srv/share" });
  });

  it("normalizes trailing slash and dot segments", () => {
    expect(validateMountPath("/srv/share/./x/", opts)).toEqual({ ok: true, path: "/srv/share/x" });
  });

  it("rejects relative and traversal paths", () => {
    expect(validateMountPath("srv/share", opts).code).toBe("not_absolute");
    expect(validateMountPath("/srv/../etc", opts).code).toBe("denied"); // normalizes to /etc
  });

  for (const p of ["/", "/etc", "/etc/ssl", "/proc", "/sys", "/dev", "/run", "/var/run",
    "/var/lib/docker", "/boot", "/root", "/usr", "/bin", "/sbin", "/lib"]) {
    it(`denies system path ${p}`, () => {
      expect(validateMountPath(p, opts).code).toBe("denied");
    });
  }

  it("denies DATA_ROOT, its children, and its ancestors", () => {
    expect(validateMountPath("/data", opts).code).toBe("denied");
    expect(validateMountPath("/data/u1", opts).code).toBe("denied");
    expect(validateMountPath("/opt/capka/data/u1", opts).code).toBe("denied"); // hostDataRoot
    expect(validateMountPath("/opt/capka", opts).code).toBe("denied");         // ancestor
    expect(validateMountPath("/opt", opts).code).toBe("denied");               // ancestor
  });

  it("boundary check: sibling of a denied path is fine (CVE-2025-53109 lesson)", () => {
    expect(validateMountPath("/data-archived", opts).ok).toBe(true);
    expect(validateMountPath("/etcetera", opts).ok).toBe(true);
  });

  it("allowlist: only subpaths of allowRoots pass; boundary-checked", () => {
    const o = { ...opts, allowRoots: ["/srv/share", "/mnt/nas"] };
    expect(validateMountPath("/srv/share", o).ok).toBe(true);
    expect(validateMountPath("/srv/share/reports", o).ok).toBe(true);
    expect(validateMountPath("/mnt/nas/x", o).ok).toBe(true);
    expect(validateMountPath("/srv/share-evil", o).code).toBe("outside_allowlist");
    expect(validateMountPath("/home/me", o).code).toBe("outside_allowlist");
  });

  it("rejects NUL bytes", () => {
    expect(validateMountPath("/srv/\0share", opts).ok).toBe(false);
  });
});
