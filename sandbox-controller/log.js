/** One structured JSON log line per event. Lifecycle events
 *  (session.create|exec|destroy|evict|recover|gc) carry sessionId/handle/image
 *  where known — never command contents. Keeps logs greppable + audit-friendly. */
export function log(event, fields = {}, level = "info") {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));
}
