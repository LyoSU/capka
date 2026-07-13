/** Pipe a spawned `tar` process's stdout to an HTTP response, failing LOUDLY on a
 *  non-zero exit. The response head is already sent (200) by the time we start
 *  streaming, so a mid-stream tar failure can't be turned into a 4xx/5xx — instead
 *  we DESTROY the socket so the client sees an aborted, incomplete download rather
 *  than a clean EOF on a truncated archive (which would masquerade as a valid
 *  backup). `pipe(res, { end: false })` keeps us in control of `res.end()`: it is
 *  called ONLY on a clean exit (code 0), so a non-zero exit never ends the response
 *  cleanly. */
export function streamArchive(child, res, log) {
  let stderr = "";
  child.stderr?.on("data", (d) => { if (stderr.length < 2000) stderr += String(d); });
  child.stdout.on("error", () => res.destroy());
  child.on("error", (e) => {
    log?.("archive.spawn_error", { err: e.message }, "warn");
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Archive failed" }));
    } else {
      res.destroy(e);
    }
  });
  child.stdout.pipe(res, { end: false });
  child.on("close", (code) => {
    if (code === 0) { res.end(); return; }
    log?.("archive.failed", { code, stderr: stderr.slice(0, 500) }, "warn");
    // Truncate the download: an incomplete archive must never look "complete".
    res.destroy(new Error(`tar exited with code ${code}`));
  });
}
