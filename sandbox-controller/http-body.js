/** JSON control bodies are tiny; cap them so a hostile/runaway request can't buffer
 *  unbounded memory. Uploads use the separate streaming MAX_UPLOAD gate, not this. */
export const MAX_BODY = 1024 * 1024; // 1 MB

/** /exec is the one control body that carries data: the platform's file tools
 *  inline the whole content as base64 (~1.37× after the JSON around it), so 1 MB
 *  failed every write above ~750 KB. 8 MB admits a ~5.8 MB file, which is more
 *  than a model can emit in one tool call, while staying a small slice of the
 *  controller's default 1 GB cgroup: a body exists as up to ~6 transient copies
 *  (chunks, joined buffer, decoded text, parsed command, the stdin buffer), so
 *  ~50 MB at worst per in-flight exec — and execs at the cap are rare, since only
 *  file-content tools come near it. Inside the sandbox it never touches the 64 MB
 *  /tmp: the command reaches bash over the exec's stdin. */
export const MAX_EXEC_BODY = 8 * 1024 * 1024;

/** Read and JSON-parse a request body, rejecting with a 413-tagged error as soon as
 *  it passes `maxBytes` — before buffering the rest. Malformed JSON parses as {}. */
export function parseBody(req, maxBytes = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { resolve({}); } });
    req.on("error", reject);
  });
}
