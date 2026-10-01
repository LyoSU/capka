/** Gemini sometimes WRITES a function call into its reply instead of making it:
 *  `call:default_api:update_plan{steps:[{status:done,title:…}]}` lands in the text
 *  (or the reasoning) as plain characters. Nothing ran, and the line is machine
 *  noise to a reader. This finds those spans so display can drop them.
 *
 *  Deliberately narrow: a span counts only when the name after `default_api:` is
 *  one of OUR tools (the caller says which), so prose that happens to contain the
 *  pattern with any other name is left alone. The span runs to the brace that
 *  closes the payload; an unclosed payload (still streaming, or malformed) runs to
 *  the end of its line. */
const MARK = /call:default_api:([A-Za-z_][\w-]*)\{/g;

type Span = { start: number; end: number; name: string };

function findSpans(text: string, isOurTool: (name: string) => boolean): Span[] {
  const spans: Span[] = [];
  if (!text.includes("call:default_api:")) return spans;
  MARK.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = MARK.exec(text)); ) {
    if (!isOurTool(m[1])) continue;
    let depth = 0;
    let quote = "";
    let end = -1;
    for (let i = m.index + m[0].length - 1; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = "";
        continue;
      }
      if (c === '"' || c === "'") quote = c;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) { end = i + 1; break; }
    }
    if (end < 0) {
      const nl = text.indexOf("\n", m.index);
      end = nl < 0 ? text.length : nl;
    }
    spans.push({ start: m.index, end, name: m[1] });
    MARK.lastIndex = end;
  }
  return spans;
}

/** The names of our tools the text "called" as text, in order — for logging. */
export function pseudoToolCallNames(text: string, isOurTool: (name: string) => boolean): string[] {
  return findSpans(text, isOurTool).map((s) => s.name);
}

/** `text` with every textual call to one of our tools removed. Text without one is
 *  returned as the same string. A line the removal leaves blank goes with it, and
 *  a fence wrapped around nothing but the call is dropped. */
export function stripPseudoToolCalls(text: string, isOurTool: (name: string) => boolean): string {
  const spans = findSpans(text, isOurTool);
  if (!spans.length) return text;
  let out = "";
  let at = 0;
  for (const s of spans) {
    let { start, end } = s;
    // A call the model fenced on its own (```tool_code … ```) takes its fence along.
    const open = /```[\w-]*[ \t]*\n[ \t]*$/.exec(text.slice(at, start));
    const close = /^[ \t]*\n?```/.exec(text.slice(end));
    // Only an OPENING fence: an odd count before it, else this is the closing fence
    // of an earlier block and the one after opens the next.
    const inside = (text.slice(0, start).match(/```/g)?.length ?? 0) % 2 === 1;
    if (open && close && inside) { start -= open[0].length; end += close[0].length; }
    // A call that had its line to itself takes the line break with it.
    if ((start === 0 || text[start - 1] === "\n") && text[end] === "\n") end++;
    out += text.slice(at, start);
    at = end;
  }
  out += text.slice(at);
  return out
    .replace(/^[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Built-in tool names, for display code that cannot see the turn's tool set (the
 *  runner checks against the real one). A name missing here only means a leaked
 *  call stays visible, as it did before; connector tools match by their prefix. */
const BUILTIN_TOOLS = new Set([
  "execute_bash", "execute_python", "execute_node", "check_job",
  "read_file", "write_file", "str_replace", "list_files", "search_files", "delete_path", "view_file",
  "manage", "ask", "skill", "update_plan", "find_tool", "nothing_to_report", "google_search",
  "memory_search", "memory_fact_write", "memory_note_write", "memory_open", "memory_file", "memory_link", "memory_forget",
]);

export const isKnownToolName = (name: string) => BUILTIN_TOOLS.has(name) || name.startsWith("mcp__");
