/** Fail-closed: the secure profile MUST run on the gVisor runtime (runsc), and
 *  that runtime MUST be registered on the daemon — else refuse to boot, never
 *  silently downgrade to plain runc. The dev profile imposes no requirement. */
export async function assertRuntimeAvailable(docker, { profile, runtime }) {
  if (profile !== "secure") return;
  // A secure profile on runc (or anything but runsc) is the silent-downgrade hole:
  // hardening was asked for but standard Docker isolation would run untrusted code.
  if (runtime !== "runsc") {
    throw new Error(
      `FATAL: secure profile requires the gVisor runtime, but SANDBOX_RUNTIME="${runtime}".\n` +
      `  Set SANDBOX_RUNTIME=runsc (and install gVisor: scripts/install-gvisor.sh),\n` +
      `  or use SANDBOX_PROFILE=dev for a trusted/dev deploy on runc.`,
    );
  }
  const info = await docker.info();
  if (!info?.Runtimes || !info.Runtimes[runtime]) {
    throw new Error(
      `FATAL: runtime "${runtime}" not registered on the Docker daemon.\n` +
      `  Secure profile requires gVisor. Install it (scripts/install-gvisor.sh)\n` +
      `  or set SANDBOX_PROFILE=dev explicitly for a trusted/dev deploy.`,
    );
  }
}
