/**
 * Share-link import is EXPERIMENTAL and off by default. An operator opts in with
 * `CAPKA_SHARE_IMPORT=true` (or 1/yes/on). Kept in its own dependency-free module
 * so both server components and API routes can read it without pulling the
 * sandbox render pipeline. The client never reads env — the resolved boolean is
 * threaded down as a prop.
 */
export function isShareImportEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.CAPKA_SHARE_IMPORT ?? "");
}
