/**
 * The Playwright script that runs INSIDE the sandbox to pull a shared
 * conversation's raw payload. It is a dumb data-grabber: it renders the public
 * page in a real (headless) browser — which is what gets past Cloudflare and,
 * for ChatGPT, lets the app hydrate its serialized state — then hands back the
 * raw provider structure. All parsing/validation happens on the platform side
 * (`parse.ts`), so this stays small and the untrusted payload never influences
 * platform code beyond being JSON.
 *
 * Contract: prints exactly one line of JSON to stdout, one of
 *   {"ok":true,"raw":<provider payload>}
 *   {"ok":false,"code":"BLOCKED|NOT_FOUND|FORMAT_CHANGED|PLAYWRIGHT_MISSING|RENDER_FAILED"}
 * Inputs arrive as base64(JSON {url, source}) in CAPKA_IMPORT_ARGS so no shell
 * quoting ever touches the URL.
 *
 * NOTE: kept free of backticks and ${...} so it embeds cleanly as a plain
 * string; the platform base64-encodes it into an exec command. Written as CommonJS
 * (require, not import) so NODE_PATH — which the exec command points at the global
 * node_modules — resolves `playwright` regardless of the script's own directory.
 */
export const SANDBOX_IMPORT_SCRIPT = `
const args = JSON.parse(Buffer.from(process.env.CAPKA_IMPORT_ARGS || "", "base64").toString("utf8"));
const url = String(args.url || "");
const source = String(args.source || "");

// Wrap the payload in sentinels so the platform can extract it cleanly even if
// the browser/runtime writes stray noise to stdout around it.
function emit(obj) { process.stdout.write("<<<CAPKA_IMPORT>>>" + JSON.stringify(obj) + "<<<CAPKA_END>>>"); }

async function main() {
  let chromium;
  try {
    chromium = require("playwright").chromium;
  } catch (e) {
    try { chromium = require("playwright-core").chromium; }
    catch (e2) { emit({ ok: false, code: "PLAYWRIGHT_MISSING" }); return; }
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const ctx = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
    });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    if (source === "claude") {
      const uuid = url.split("/").filter(Boolean).pop();
      // The share page establishes the Cloudflare clearance cookie; fetching the
      // snapshot API from the page context then succeeds where a bare request 403s.
      const result = await page.evaluate(async (id) => {
        try {
          const r = await fetch("/api/chat_snapshots/" + id + "?rendering_mode=messages&render_all_tools=true", { headers: { accept: "application/json" } });
          if (!r.ok) return { __status: r.status };
          return { __json: await r.json() };
        } catch (err) {
          return { __status: 0 };
        }
      }, uuid);
      if (result && result.__json) { emit({ ok: true, raw: result.__json }); return; }
      const status = result ? result.__status : 0;
      if (status === 404) { emit({ ok: false, code: "NOT_FOUND" }); return; }
      if (status === 403 || status === 0) { emit({ ok: false, code: "BLOCKED" }); return; }
      emit({ ok: false, code: "FORMAT_CHANGED" }); return;
    }

    if (source === "chatgpt") {
      // Wait for React Router to hydrate its loader data, then dig out the object
      // holding the conversation tree (mapping + current_node) wherever it sits.
      try {
        const handle = await page.waitForFunction(() => {
          const dr = window.__reactRouterDataRouter;
          const ld = dr && dr.state && dr.state.loaderData;
          if (!ld) return null;
          function find(o, d) {
            if (!o || typeof o !== "object" || d > 6) return null;
            if (o.mapping && o.current_node) return o;
            for (const v of Object.values(o)) { const r = find(v, d + 1); if (r) return r; }
            return null;
          }
          const c = find(ld, 0);
          if (!c) return null;
          return { title: c.title || null, mapping: c.mapping, current_node: c.current_node };
        }, { timeout: 30000, polling: 500 });
        const raw = await handle.jsonValue();
        if (raw && raw.mapping) { emit({ ok: true, raw: raw }); return; }
        emit({ ok: false, code: "FORMAT_CHANGED" }); return;
      } catch (e) {
        // Never hydrated: either a bot challenge or the page shape moved.
        const title = (await page.title().catch(() => "")) || "";
        if (/just a moment|attention required|verify you are human/i.test(title)) { emit({ ok: false, code: "BLOCKED" }); return; }
        emit({ ok: false, code: "FORMAT_CHANGED" }); return;
      }
    }

    emit({ ok: false, code: "FORMAT_CHANGED" });
  } catch (e) {
    emit({ ok: false, code: "RENDER_FAILED" });
  } finally {
    if (browser) { try { await browser.close(); } catch (e) {} }
  }
}

main().catch(() => { process.stdout.write(JSON.stringify({ ok: false, code: "RENDER_FAILED" })); });
`;
