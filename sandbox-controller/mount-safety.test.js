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

  for (const p of ["/lib64", "/lib32", "/libx32"]) {
    it(`denies ${p} — a sibling of /lib, which no containment check reaches`, () => {
      expect(validateMountPath(p, opts).code).toBe("denied");
    });
  }

  it("denies an ANCESTOR of a system path, not just a descendant", () => {
    // The check used to run one way, so /var/run/docker.sock was denied while mounting
    // its parent /var handed the sandbox the very same socket.
    expect(validateMountPath("/var", opts).code).toBe("denied");       // contains /var/run
    expect(validateMountPath("/var/lib", opts).code).toBe("denied");   // contains /var/lib/docker
  });

  it("but an unrelated subtree of /var is still mountable", () => {
    // Denying by containment rather than by blanket-listing "/var" is what keeps this
    // usable: an admin can still confirm a web root or a reports directory.
    expect(validateMountPath("/var/www", opts).ok).toBe(true);
    expect(validateMountPath("/var/lib-reports", opts).ok).toBe(true); // boundary, not /var/lib
  });

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

  it("allowlist: a root written with a trailing slash still matches", () => {
    const o = { ...opts, allowRoots: ["/srv/shared/"] };
    expect(validateMountPath("/srv/shared/reports", o).ok).toBe(true);
    expect(validateMountPath("/srv/shared", o).ok).toBe(true);
    expect(validateMountPath("/srv/shared/", o).ok).toBe(true);
    expect(validateMountPath("/srv/elsewhere", o).code).toBe("outside_allowlist");
  });

  it("rejects NUL bytes", () => {
    expect(validateMountPath("/srv/\0share", opts).ok).toBe(false);
  });
});
