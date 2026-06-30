/** Resolve the isolation runtime + profile from env-style inputs.
 *
 *  gVisor is OPT-IN. The default runtime is runc — it works on any Docker host
 *  with zero extra setup, so a fresh deploy boots immediately. That yields the
 *  "standard" profile (ordinary Docker isolation only). Set SANDBOX_RUNTIME=runsc
 *  to opt into the hardened "secure" profile, which is then fail-closed: boot
 *  refuses if runsc isn't registered on the daemon (see runtime-check.js), so an
 *  explicit request for hardening never silently downgrades. An explicit
 *  SANDBOX_PROFILE overrides the derived value.
 *
 *  ("standard" was historically labelled "dev" — renamed so a normal production
 *  deploy on runc doesn't surface an alarming "dev" profile in its logs.) */
export function resolveRuntimeProfile({ runtime, profile } = {}) {
  const rt = runtime || "runc";
  const prof = profile || (rt === "runc" ? "standard" : "secure");
  return { runtime: rt, profile: prof };
}
