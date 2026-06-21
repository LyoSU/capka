/** Resolve the isolation runtime + profile from env-style inputs.
 *
 *  gVisor is OPT-IN. The default runtime is runc — it works on any Docker host
 *  with zero extra setup, so a fresh deploy boots immediately. That yields the
 *  "dev" profile (standard Docker isolation only). Set SANDBOX_RUNTIME=runsc to
 *  opt into the hardened "secure" profile, which is then fail-closed: boot
 *  refuses if runsc isn't registered on the daemon (see runtime-check.js), so an
 *  explicit request for hardening never silently downgrades. An explicit
 *  SANDBOX_PROFILE overrides the derived value. */
export function resolveRuntimeProfile({ runtime, profile } = {}) {
  const rt = runtime || "runc";
  const prof = profile || (rt === "runc" ? "dev" : "secure");
  return { runtime: rt, profile: prof };
}
