import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { streamArchive } from "./archive-stream.js";

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

function fakeRes() {
  const res = new Writable({ write(_c, _e, cb) { cb(); } });
  res.headersSent = true;
  res._ended = false;
  res._destroyedErr = null; // set only when destroyed WITH an error (the truncation path)
  res.on("error", () => {}); // destroy(err) emits 'error'; swallow so it isn't unhandled
  const origEnd = res.end.bind(res);
  res.end = (...a) => { res._ended = true; return origEnd(...a); };
  const origDestroy = res.destroy.bind(res);
  // A Writable auto-destroys after a clean end() with NO error; only a destroy(err)
  // is the deliberate truncation we assert on.
  res.destroy = (err, ...a) => { if (err) res._destroyedErr = err; return origDestroy(err, ...a); };
  return res;
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("streamArchive", () => {
  it("ends the response cleanly on a zero tar exit", async () => {
    const child = fakeChild();
    const res = fakeRes();
    streamArchive(child, res, () => {});
    child.stdout.write(Buffer.from([0x1f, 0x8b]));
    child.stdout.end();
    child.emit("close", 0);
    await tick();
    expect(res._ended).toBe(true);
    expect(res._destroyedErr).toBeNull(); // clean end, no error-destroy
  });

  it("destroys the response on a non-zero tar exit (truncated, never a clean archive)", async () => {
    const child = fakeChild();
    const res = fakeRes();
    const logs = [];
    streamArchive(child, res, (ev) => logs.push(ev));
    child.stdout.write(Buffer.from([0x1f, 0x8b])); // some bytes already flushed
    child.stdout.end();
    child.stderr.write("tar: some file vanished\n");
    child.emit("close", 1);
    await tick();
    expect(res._destroyedErr).toBeInstanceOf(Error);
    expect(res._ended).toBe(false);
    expect(logs).toContain("archive.failed");
  });

  it("500s a spawn error before any bytes are sent", async () => {
    const child = fakeChild();
    const res = fakeRes();
    res.headersSent = false;
    let status = 0;
    res.writeHead = (s) => { status = s; };
    streamArchive(child, res, () => {});
    child.emit("error", new Error("spawn tar ENOENT"));
    await tick();
    expect(status).toBe(500);
  });
});
