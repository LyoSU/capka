/** Demultiplexer for Docker's multiplexed attach/exec stream.
 *
 *  Docker frames each payload as an 8-byte header — [streamType, 0, 0, 0,
 *  size:uint32be] — followed by `size` bytes. streamType 1 = stdout, 2 = stderr.
 *  Crucially, these frames are NOT aligned to the TCP/Node chunk boundaries the
 *  socket delivers: a single 'data' event may contain several frames, a partial
 *  frame, or a header split down the middle. The previous inline parser dropped
 *  any partial frame at the end of a chunk and then mis-parsed the next chunk
 *  from the middle of a frame, corrupting/truncating output once it grew past a
 *  single chunk. This buffers the remainder across events so frames reassemble
 *  correctly regardless of how the bytes arrive.
 *
 *  Payloads are accumulated as raw bytes and decoded once at the end, so a
 *  multi-byte UTF-8 character split across two frames still decodes correctly. */
export function createFrameDemux() {
  let buf = Buffer.alloc(0);
  const out = [];
  const err = [];

  return {
    /** Feed one chunk from the stream's 'data' event. */
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
      while (buf.length >= 8) {
        const type = buf[0];
        const size = buf.readUInt32BE(4);
        if (buf.length < 8 + size) break; // wait for the rest of this frame
        const payload = Buffer.from(buf.subarray(8, 8 + size));
        if (type === 1) out.push(payload);
        else if (type === 2) err.push(payload);
        buf = buf.subarray(8 + size);
      }
    },
    /** Decode the accumulated stdout/stderr. Call after the stream ends. */
    result() {
      return {
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      };
    },
  };
}

/** Encode a payload as a Docker stream frame (test helper / symmetry). */
export function encodeFrame(type, text) {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}
