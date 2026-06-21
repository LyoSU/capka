/** Fail-closed: in the secure profile the configured gVisor runtime MUST exist
 *  on the daemon, else refuse to boot (never silently downgrade to runc). */
export async function assertRuntimeAvailable(docker, { profile, runtime }) {
  if (profile === "dev" || runtime === "runc") return;
  const info = await docker.info();
  if (!info?.Runtimes || !info.Runtimes[runtime]) {
    throw new Error(
      `FATAL: runtime "${runtime}" not registered on the Docker daemon.\n` +
      `  Secure profile requires gVisor. Install it (scripts/install-gvisor.sh)\n` +
      `  or set SANDBOX_RUNTIME=runc explicitly for a trusted/dev deploy.`,
    );
  }
}
