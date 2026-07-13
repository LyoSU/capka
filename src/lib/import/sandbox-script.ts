/**
 * The Playwright script that runs INSIDE the sandbox to pull a shared
 * conversation's raw payload. It is a dumb data-grabber: it renders the public
 * page in a real (headless) browser — which is what gets past Cloudflare, lets
 * the ChatGPT app hydrate its serialized state, and lets a share-API fetch reuse
 * the page's clearance cookie (Claude, Grok) — then hands back the raw provider
 * structure. Gemini has no share API, so its branch scrapes the rendered DOM and
 * hands back an already-flattened { title, turns, droppedRichContent } shape. All
 * parsing/validation happens on the platform side (`parse.ts`), so this stays
 * small and the untrusted payload never influences platform code beyond being JSON.
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

/**
 * Node-side projections of provider payloads down to the fields parse.ts
 * actually reads, capped so the emitted JSON always fits the controller's ~1MB
 * stdout ceiling. Without this, a payload's dead weight (Grok steps +
 * webSearchResults, Claude tool/thinking blocks, ChatGPT per-node metadata)
 * trips the ceiling and fails the whole import even when the conversation text
 * itself is small — ~94% of a real oversized Grok share was fields the parser
 * discards anyway.
 *
 * Cap semantics: each text keeps a +9-char margin past the per-message cap so
 * the platform's normalizeImport still SEES the overage and clips/flags it
 * itself (single source of truth for the visible clip marker); when the caps
 * force dropping data the platform can no longer observe (whole messages past
 * the count/byte budget), __capkaTruncated carries that fact instead. Rich
 * content the parser would detect from fields we no longer ship travels as a
 * per-message hasRichContent: true.
 *
 * Exported separately (and spliced into SANDBOX_IMPORT_SCRIPT below) so unit
 * tests can exercise the projection logic directly via new Function.
 */
export const IMPORT_PROJECTIONS = `
function importCapText(v, caps) {
  var s = typeof v === "string" ? v : "";
  return s.length > caps.maxMsgChars + 9 ? s.slice(0, caps.maxMsgChars + 9) : s;
}

function projectGrokImport(json, caps) {
  var root = json || {};
  var conv = root.conversation || {};
  var src = Array.isArray(root.responses) ? root.responses : [];
  var out = [];
  var bytes = 0;
  var truncated = false;
  for (var i = 0; i < src.length; i++) {
    var r = src[i] || {};
    if (out.length > caps.maxMessages) { truncated = true; break; }
    var m = importCapText(r.message, caps);
    bytes += Buffer.byteLength(m, "utf8");
    if (bytes > caps.maxTotalBytes) { truncated = true; break; }
    var rich =
      (Array.isArray(r.webSearchResults) && r.webSearchResults.length > 0) ||
      (Array.isArray(r.xposts) && r.xposts.length > 0) ||
      (Array.isArray(r.xpostIds) && r.xpostIds.length > 0) ||
      (Array.isArray(r.generatedImageUrls) && r.generatedImageUrls.length > 0) ||
      (Array.isArray(r.imageAttachments) && r.imageAttachments.length > 0) ||
      (Array.isArray(r.fileAttachments) && r.fileAttachments.length > 0);
    var slim = { sender: r.sender, message: m };
    if (rich) slim.hasRichContent = true;
    out.push(slim);
  }
  return { conversation: { title: conv.title || null }, responses: out, __capkaTruncated: truncated };
}

function projectClaudeImport(json, caps) {
  var root = json || {};
  var src = Array.isArray(root.chat_messages) ? root.chat_messages : [];
  var out = [];
  var bytes = 0;
  var truncated = false;
  for (var i = 0; i < src.length; i++) {
    var m = src[i] || {};
    if (out.length > caps.maxMessages) { truncated = true; break; }
    var blocks = Array.isArray(m.content) ? m.content : [];
    var texts = [];
    var rich = false;
    for (var j = 0; j < blocks.length; j++) {
      var b = blocks[j] || {};
      if (b.type === "text") {
        if (typeof b.text === "string" && b.text) texts.push({ type: "text", text: importCapText(b.text, caps) });
      } else {
        rich = true;
      }
    }
    if (
      (Array.isArray(m.attachments) && m.attachments.length > 0) ||
      (Array.isArray(m.files) && m.files.length > 0) ||
      Number(m.image_count) > 0 ||
      Number(m.file_count) > 0
    ) rich = true;
    var flat = texts.length ? "" : importCapText(m.text, caps);
    var size = Buffer.byteLength(flat, "utf8");
    for (var k = 0; k < texts.length; k++) size += Buffer.byteLength(texts[k].text, "utf8");
    bytes += size;
    if (bytes > caps.maxTotalBytes) { truncated = true; break; }
    var slim = { sender: m.sender, content: texts, text: flat };
    if (rich) slim.hasRichContent = true;
    out.push(slim);
  }
  return { snapshot_name: root.snapshot_name || null, chat_messages: out, __capkaTruncated: truncated };
}

function projectChatGptImport(json, caps) {
  var root = json || {};
  var mapping = root.mapping && typeof root.mapping === "object" ? root.mapping : {};
  var slim = {};
  var bytes = 0;
  var truncated = false;
  var ids = Object.keys(mapping);
  for (var i = 0; i < ids.length; i++) {
    var node = mapping[ids[i]] || {};
    var entry = { parent: node.parent, children: Array.isArray(node.children) ? node.children : [] };
    var msg = node.message;
    if (msg && typeof msg === "object") {
      var content = msg.content && typeof msg.content === "object" ? msg.content : {};
      var parts = Array.isArray(content.parts) ? content.parts : [];
      var slimParts = [];
      for (var j = 0; j < parts.length; j++) {
        if (typeof parts[j] === "string") {
          var t = importCapText(parts[j], caps);
          bytes += Buffer.byteLength(t, "utf8");
          slimParts.push(t);
        } else {
          slimParts.push(null); // non-string marker: the parser reads it as rich content
        }
      }
      entry.message = {
        author: { role: msg.author && msg.author.role },
        content: { content_type: content.content_type, parts: slimParts },
      };
    }
    slim[ids[i]] = entry;
    // Mapping order isn't branch order, so a byte overflow can't drop "the tail"
    // precisely — stop enlarging and let the parser's branch walk surface
    // whatever survived, flagged as truncated.
    if (bytes > caps.maxTotalBytes) { truncated = true; break; }
  }
  return { title: root.title || null, mapping: slim, current_node: root.current_node, __capkaTruncated: truncated };
}
`;

export const SANDBOX_IMPORT_SCRIPT = `
const args = JSON.parse(Buffer.from(process.env.CAPKA_IMPORT_ARGS || "", "base64").toString("utf8"));
const url = String(args.url || "");
const source = String(args.source || "");
// Caps arrive from render.ts (mirroring the platform's MAX_IMPORT_* constants);
// the defaults are a safety net sized to the controller's stdout ceiling.
const rawCaps = args.caps || {};
const caps = {
  maxMessages: Number(rawCaps.maxMessages) || 200,
  maxMsgChars: Number(rawCaps.maxMsgChars) || 100000,
  maxTotalBytes: Number(rawCaps.maxTotalBytes) || 700000,
};
` + IMPORT_PROJECTIONS + `

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
      if (result && result.__json) { emit({ ok: true, raw: projectClaudeImport(result.__json, caps) }); return; }
      const status = result ? result.__status : 0;
      if (status === 404) { emit({ ok: false, code: "NOT_FOUND" }); return; }
      if (status === 403 || status === 0) { emit({ ok: false, code: "BLOCKED" }); return; }
      emit({ ok: false, code: "FORMAT_CHANGED" }); return;
    }

    if (source === "grok") {
      const shareId = url.split("/").filter(Boolean).pop();
      // Same trick as Claude: fetch the share API from the page context so the
      // Cloudflare clearance cookie is present. CRITICAL: no useChunk param — with
      // it the "message" fields come back empty.
      const result = await page.evaluate(async (id) => {
        try {
          const r = await fetch("/rest/app-chat/share_links/" + id, { headers: { accept: "application/json" } });
          if (!r.ok) return { __status: r.status };
          return { __json: await r.json() };
        } catch (err) {
          return { __status: 0 };
        }
      }, shareId);
      if (result && result.__json) { emit({ ok: true, raw: projectGrokImport(result.__json, caps) }); return; }
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
        if (raw && raw.mapping) { emit({ ok: true, raw: projectChatGptImport(raw, caps) }); return; }
        emit({ ok: false, code: "FORMAT_CHANGED" }); return;
      } catch (e) {
        // Never hydrated: either a bot challenge or the page shape moved.
        const title = (await page.title().catch(() => "")) || "";
        if (/just a moment|attention required|verify you are human/i.test(title)) { emit({ ok: false, code: "BLOCKED" }); return; }
        emit({ ok: false, code: "FORMAT_CHANGED" }); return;
      }
    }

    if (source === "gemini") {
      // Gemini has no share JSON API, so we scrape the rendered DOM. Wait for the
      // first turn; if it never appears, tell a bot-challenge from a dead/moved
      // page apart the same way the ChatGPT branch does.
      try {
        await page.waitForSelector("share-turn-viewer", { timeout: 30000 });
      } catch (e) {
        const title = (await page.title().catch(() => "")) || "";
        if (/just a moment|attention required|verify you are human|unusual traffic/i.test(title)) { emit({ ok: false, code: "BLOCKED" }); return; }
        const body = (await page.evaluate(() => (document.body ? document.body.innerText : "")).catch(() => "")) || "";
        if (/(not found|no longer available|doesn't exist|couldn.t find|removed|404)/i.test(body)) { emit({ ok: false, code: "NOT_FOUND" }); return; }
        emit({ ok: false, code: "FORMAT_CHANGED" }); return;
      }

      // Long conversations lazy-load: scroll to the bottom until the turn count
      // stops growing (or we hit a sane ceiling).
      let prev = -1;
      for (let i = 0; i < 15; i++) {
        const n = await page.evaluate(() => document.querySelectorAll("share-turn-viewer").length);
        if (n === prev) break;
        prev = n;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(400);
      }

      const raw = await page.evaluate((caps) => {
        // HTML -> markdown, run in-page so the DOM is live. Kept backtick- and
        // template-literal-free for clean embedding: BT is a literal backtick from
        // its code point, and every runtime newline is written as an escape.
        const BT = String.fromCharCode(96);
        const FENCE = BT + BT + BT;
        const BLOCK = { p: 1, div: 1, pre: 1, ul: 1, ol: 1, table: 1, blockquote: 1, section: 1, article: 1, hr: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1 };
        // Gemini wraps code blocks (and other structure) in custom elements —
        // e.g. a <code-block> with a toolbar around the real <pre>. Any element
        // hiding one of these must be walked as a block container, never
        // flattened to inline text, or fences/lists silently degrade to prose.
        const BLOCKISH = "pre, ul, ol, table, blockquote, h1, h2, h3, h4, h5, h6";

        // Gemini's DOM is full of Angular CDK a11y scaffolding (screen-reader
        // labels, aria-hidden decorations) and per-block chrome (copy buttons,
        // code-block language headers, icons). Skipping those elements is what
        // keeps the "Your message" label out of the query and toolbar text out
        // of prose; a real <pre> never sits inside a button, so code is safe.
        function isHidden(el) {
          if (!el || el.nodeType !== 1) return false;
          const tag = el.tagName.toLowerCase();
          if (tag === "button" || tag === "mat-icon" || tag === "gem-icon") return true;
          const role = el.getAttribute("role");
          if (role === "button" || role === "toolbar" || role === "tooltip") return true;
          const cls = el.getAttribute("class") || "";
          if (/(^|\\s)cdk-visually-hidden(\\s|$)/.test(cls)) return true;
          // Code-block chrome: the header strip with the language label and the
          // copy button (div.code-block-decoration > span "Python" …). The label
          // is read separately by blockOf(pre); as prose it would leak as a stray
          // line right before every fence.
          if (/(^|\\s)code-block-decoration(\\s|$)/.test(cls)) return true;
          if (el.getAttribute("aria-hidden") === "true") return true;
          return false;
        }

        function visibleText(node) {
          let s = "";
          const kids = node.childNodes;
          for (let i = 0; i < kids.length; i++) {
            const k = kids[i];
            if (k.nodeType === 3) { s += (k.nodeValue || ""); continue; }
            if (k.nodeType !== 1 || isHidden(k)) continue;
            s += visibleText(k);
          }
          return s;
        }

        function inlineOf(node) {
          let s = "";
          const kids = node.childNodes;
          for (let i = 0; i < kids.length; i++) {
            const k = kids[i];
            if (k.nodeType === 3) { s += (k.nodeValue || ""); continue; }
            if (k.nodeType !== 1 || isHidden(k)) continue;
            const tag = k.tagName.toLowerCase();
            if (tag === "br") { s += "\\n"; }
            else if (tag === "strong" || tag === "b") { s += "**" + inlineOf(k) + "**"; }
            else if (tag === "em" || tag === "i") { s += "*" + inlineOf(k) + "*"; }
            else if (tag === "code") { s += BT + (k.textContent || "").replace(/\\n/g, " ") + BT; }
            else if (tag === "a") {
              const href = k.getAttribute("href") || "";
              const txt = inlineOf(k) || href;
              s += href ? ("[" + txt + "](" + href + ")") : txt;
            }
            else { s += inlineOf(k); }
          }
          return s;
        }

        function listOf(node, ordered, indent) {
          const lines = [];
          let idx = 1;
          const kids = node.children;
          for (let i = 0; i < kids.length; i++) {
            const li = kids[i];
            if (!li.tagName || li.tagName.toLowerCase() !== "li" || isHidden(li)) continue;
            const marker = ordered ? (idx + ". ") : "- ";
            // Split an <li> into its own inline text and any nested blocks/lists.
            let inlineParts = "";
            const nested = [];
            const cn = li.childNodes;
            for (let j = 0; j < cn.length; j++) {
              const c = cn[j];
              if (c.nodeType === 3) { inlineParts += (c.nodeValue || ""); continue; }
              if (c.nodeType !== 1 || isHidden(c)) continue;
              const ct = c.tagName.toLowerCase();
              if (ct === "ul" || ct === "ol") { nested.push(listOf(c, ct === "ol", indent + "  ")); }
              else if (ct === "pre" || ct === "blockquote" || ct === "table") { nested.push(indent + "  " + blockOf(c).replace(/\\n/g, "\\n" + indent + "  ")); }
              else if (c.querySelector(BLOCKISH)) { nested.push(indent + "  " + renderChildren(c).replace(/\\n/g, "\\n" + indent + "  ")); }
              else { inlineParts += inlineOf(c); }
            }
            const body = inlineParts.replace(/[ \\t]+/g, " ").replace(/\\n{2,}/g, "\\n").trim();
            let line = indent + marker + body.replace(/\\n/g, "\\n" + indent + "  ");
            if (nested.length) line += "\\n" + nested.join("\\n");
            lines.push(line);
            idx++;
          }
          return lines.join("\\n");
        }

        function tableOf(node) {
          const rows = node.querySelectorAll("tr");
          if (!rows.length) return inlineOf(node).replace(/[ \\t]+/g, " ").trim();
          const out = [];
          for (let r = 0; r < rows.length; r++) {
            const cells = rows[r].querySelectorAll("th,td");
            if (!cells.length) continue;
            const cols = [];
            for (let c = 0; c < cells.length; c++) cols.push(inlineOf(cells[c]).replace(/\\s+/g, " ").replace(/\\|/g, "\\\\|").trim());
            out.push("| " + cols.join(" | ") + " |");
            if (out.length === 1) {
              const sep = [];
              for (let c2 = 0; c2 < cells.length; c2++) sep.push("---");
              out.push("| " + sep.join(" | ") + " |");
            }
          }
          return out.join("\\n");
        }

        function blockOf(node) {
          const tag = node.tagName.toLowerCase();
          if (tag === "hr") return "---";
          if (tag === "pre") {
            const codeEl = node.querySelector("code");
            const cls = ((codeEl ? codeEl.getAttribute("class") : "") || "") + " " + (node.getAttribute("class") || "");
            const m = cls.match(/language-([A-Za-z0-9+#._-]+)/);
            let lang = m ? m[1] : "";
            if (!lang) {
              // Gemini carries the language as TEXT in the code-block header
              // (span "Python" / "JSON" inside .code-block-decoration), not as a
              // language- class. Read it from the enclosing wrapper.
              const wrap = node.closest("[class*='code-block']");
              const label = wrap ? wrap.querySelector(".code-block-decoration span") : null;
              const t = label && label.textContent ? label.textContent.trim() : "";
              if (/^[A-Za-z0-9+#._ -]{1,30}$/.test(t)) lang = t.toLowerCase().replace(/\\s+/g, "-");
            }
            const codeText = (codeEl ? codeEl.textContent : node.textContent) || "";
            return FENCE + lang + "\\n" + codeText.replace(/\\n+$/, "") + "\\n" + FENCE;
          }
          if (tag === "ul") return listOf(node, false, "");
          if (tag === "ol") return listOf(node, true, "");
          if (tag === "table") return tableOf(node);
          if (/^h[1-6]$/.test(tag)) {
            const hn = Number(tag.slice(1));
            let hh = "";
            for (let i = 0; i < hn; i++) hh += "#";
            return hh + " " + inlineOf(node).replace(/\\s+/g, " ").trim();
          }
          if (tag === "blockquote") {
            const parts = renderChildren(node).trim().split("\\n");
            const out = [];
            for (let i = 0; i < parts.length; i++) out.push(parts[i] ? ("> " + parts[i]) : ">");
            return out.join("\\n");
          }
          // p/div/section/… wrapping real blocks (a div around a <pre>, a custom
          // code-block element) must recurse as a container, not flatten.
          if (node.querySelector(BLOCKISH)) return renderChildren(node);
          return inlineOf(node).replace(/[ \\t]+/g, " ").trim();
        }

        function renderChildren(rootEl) {
          const chunks = [];
          let buf = "";
          function flush() { const t = buf.replace(/[ \\t]+/g, " ").trim(); if (t) chunks.push(t); buf = ""; }
          const kids = rootEl.childNodes;
          for (let i = 0; i < kids.length; i++) {
            const k = kids[i];
            if (k.nodeType === 3) { buf += (k.nodeValue || ""); continue; }
            if (k.nodeType !== 1 || isHidden(k)) continue;
            const tag = k.tagName.toLowerCase();
            if (BLOCK[tag]) { flush(); chunks.push(blockOf(k)); }
            else if (tag === "br") { buf += "\\n"; }
            else if (k.querySelector(BLOCKISH)) { flush(); chunks.push(renderChildren(k)); }
            else { buf += inlineOf(k); }
          }
          flush();
          return chunks.join("\\n\\n");
        }

        function toMarkdown(rootEl) {
          return renderChildren(rootEl).replace(/\\n{3,}/g, "\\n\\n").trim();
        }

        const viewer = document.querySelector("share-viewer") || document.body;
        const titleEl = viewer.querySelector("h1");
        const title = titleEl ? visibleText(titleEl).replace(/\\s+/g, " ").trim() : "";
        const turnEls = document.querySelectorAll("share-turn-viewer");
        const turns = [];
        let droppedRichContent = false;
        // Same cap semantics as the projection helpers: +9-char margin so the
        // platform's normalizeImport observes and clips the overage itself; a
        // count/byte overflow (whole turns dropped here) rides __capkaTruncated.
        const enc = new TextEncoder();
        const capText = (s) => (s.length > caps.maxMsgChars + 9 ? s.slice(0, caps.maxMsgChars + 9) : s);
        let msgCount = 0;
        let bytes = 0;
        let capTruncated = false;
        for (let i = 0; i < turnEls.length; i++) {
          const tv = turnEls[i];
          if (msgCount > caps.maxMessages) { capTruncated = true; break; }

          // User query: the p.query-text-line paragraphs (a multi-line query has
          // several), excluding the cdk screen-reader label that also sits in
          // .query-text. Fall back to visible text of .query-text if the markup moved.
          let query = "";
          const uq = tv.querySelector("user-query-content");
          if (uq) {
            const lines = uq.querySelectorAll("p.query-text-line");
            if (lines.length) {
              const parts = [];
              for (let j = 0; j < lines.length; j++) {
                if (isHidden(lines[j])) continue;
                parts.push(visibleText(lines[j]).replace(/[ \\t]+/g, " ").trim());
              }
              query = parts.join("\\n").trim();
            } else {
              const qt = uq.querySelector(".query-text") || uq;
              query = visibleText(qt).replace(/[ \\t]+/g, " ").trim();
            }
            // Attachments in the query. NOTE: an EMPTY div.file-preview-container
            // is present even on plain text turns, so require actual content in
            // it (or any image) before flagging rich content.
            if (uq.querySelector(".file-preview-container *, img")) droppedRichContent = true;
          }

          // Response: convert the .markdown panel inside message-content — never the
          // whole response-container, which also holds toolbars and action buttons.
          let response = "";
          const mc = tv.querySelector("response-container message-content") || tv.querySelector("message-content");
          if (mc) {
            const md = mc.querySelector(".markdown-main-panel") || mc.querySelector(".markdown") || mc;
            response = toMarkdown(md);
            if (mc.querySelector("img, canvas, video, audio, source")) droppedRichContent = true;
          }

          query = capText(query);
          response = capText(response);
          bytes += enc.encode(query).length + enc.encode(response).length;
          if (bytes > caps.maxTotalBytes) { capTruncated = true; break; }
          msgCount += (query ? 1 : 0) + (response ? 1 : 0);
          turns.push({ query: query, response: response });
        }
        return { title: title || null, turns: turns, droppedRichContent: droppedRichContent, __capkaTruncated: capTruncated };
      }, caps);

      if (raw && raw.turns) { emit({ ok: true, raw: raw }); return; }
      emit({ ok: false, code: "FORMAT_CHANGED" }); return;
    }

    emit({ ok: false, code: "FORMAT_CHANGED" });
  } catch (e) {
    emit({ ok: false, code: "RENDER_FAILED" });
  } finally {
    if (browser) { try { await browser.close(); } catch (e) {} }
  }
}

main().catch(() => { emit({ ok: false, code: "RENDER_FAILED" }); });
`;
