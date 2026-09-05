import type { CodeHighlighterPlugin } from "streamdown";

/**
 * Syntax highlighting is deferred for the one code block that is still being
 * written.
 *
 * Streamdown memoizes finished blocks, so a growing reply re-renders only its
 * tail — except that a code block in the tail is re-tokenized in full by shiki on
 * every render, and that cost grows with the block. It is the one place a
 * streaming renderer visibly stalls (a long listing arriving at 20 renders/s),
 * and it buys nothing: nobody reads syntax colour on a line that is still
 * arriving. So while the reply's text ends inside an open fence, the highlighter
 * hands that block back as plain tokens, and tokenizes it once when the fence
 * closes. Blocks that closed earlier are untouched — shiki caches by content, so
 * they are a map lookup.
 */

type HighlightResult = NonNullable<ReturnType<CodeHighlighterPlugin["highlight"]>>;

/**
 * The body of the fenced code block `text` ends inside, with trailing newlines
 * removed (the shape the highlighter is asked for), or null when the text is not
 * inside an open fence. Fences are ``` or ~~~ lines indented at most three
 * spaces; a fence closes on a marker of the same character at least as long.
 */
export function openFenceBody(text: string): string | null {
  let fence: { char: string; len: number; bodyAt: number } | null = null;
  let at = 0;
  for (const line of text.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (m) {
      const char = m[1][0];
      const len = m[1].length;
      if (!fence) {
        // An opening ``` fence may not carry a backtick in its info string.
        if (!(char === "`" && line.slice(m[0].length).includes("`"))) fence = { char, len, bodyAt: at + line.length + 1 };
      } else if (char === fence.char && len >= fence.len && line.slice(m[0].length).trim() === "") {
        fence = null;
      }
    }
    at += line.length + 1;
  }
  if (!fence) return null;
  return text.slice(Math.min(fence.bodyAt, text.length)).replace(/\n+$/, "");
}

/** Plain tokens in the shape shiki returns — one token per line, colours inherited. */
function plainTokens(code: string): HighlightResult {
  return {
    bg: "transparent",
    fg: "inherit",
    tokens: code.split("\n").map((line) => [{ content: line, offset: 0, color: "inherit", bgColor: "transparent", htmlStyle: {} }]),
  } as HighlightResult;
}

/**
 * The highlighter with the live block deferred. `isLive` answers whether a code
 * string is the block still being written (see `openFenceBody`); everything else
 * goes to the real highlighter unchanged.
 */
export function deferLiveHighlight(plugin: CodeHighlighterPlugin, isLive: (code: string) => boolean): CodeHighlighterPlugin {
  return {
    ...plugin,
    highlight: (options, callback) => (isLive(options.code) ? plainTokens(options.code) : plugin.highlight(options, callback)),
  };
}
