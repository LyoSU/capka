"use client";

import type { ComponentPropsWithoutRef } from "react";
import { useTranslations } from "next-intl";
import { visit, SKIP } from "unist-util-visit";
import type { Root, RootContent } from "mdast";
import { usePreview, useFileStatus, type PreviewFile } from "./file-preview";
import { fileKind, previewKind } from "@/lib/file-kinds";
import { freshWorkspacePathRe, isSafeWorkspaceRel, workspaceRelFromHref } from "@/lib/chat/artifacts";
import { CitationChip } from "./sources";
import type { NumberedSource } from "@/lib/mcp/search-normalize";
import { Hint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** An mdast link to a workspace file, captioned with just the file name. */
function fileLink(rel: string): RootContent {
  const name = rel.split("/").pop() || rel;
  return { type: "link", url: `/workspace/${rel}`, title: null, children: [{ type: "text", value: name }] };
}

/**
 * remark plugin: turn the `/workspace/<file>` paths an assistant writes — in
 * prose or in inline `code` — into links to that file. The markdown renderer
 * then shows them as clickable file chips (see makeWorkspaceComponents). Fenced
 * code blocks are a different node type and are left untouched, so code samples
 * keep their highlighting. Traversal paths are ignored (shared safe check).
 */
export function remarkWorkspacePaths() {
  return (tree: Root) => {
    visit(tree, (node, index, parent) => {
      if (!parent || index == null) return;

      if (node.type === "inlineCode") {
        const rel = workspaceRelFromHref(node.value);
        if (rel) parent.children[index] = fileLink(rel);
        return;
      }

      if (node.type === "text") {
        const value = node.value;
        // Fresh regex — the exported one is global and carries lastIndex state.
        const re = freshWorkspacePathRe();
        const out: RootContent[] = [];
        let last = 0;
        for (let m = re.exec(value); m; m = re.exec(value)) {
          if (!isSafeWorkspaceRel(m[1])) continue;
          if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
          out.push(fileLink(m[1]));
          last = m.index + m[0].length;
        }
        if (out.length === 0) return;
        if (last < value.length) out.push({ type: "text", value: value.slice(last) });
        parent.children.splice(index, 1, ...out);
        return [SKIP, index + out.length];
      }
    });
  };
}

/** Inline pill for a workspace file the model named: type icon + file name,
 *  opening Quick Look (or downloading non-previewable kinds) on click. A path the
 *  model named but never created is greyed out and inert (see useFileStatus). */
function WorkspacePathChip({ rel, chatId, live }: { rel: string; chatId: string; live?: boolean }) {
  const { open } = usePreview();
  const tw = useTranslations("chat.workspace");
  const name = rel.split("/").pop() || rel;
  const { Icon, color } = fileKind(name);
  const file: PreviewFile = { path: rel, name, chatId };
  // Verify once the reply is final (live=false); while streaming stay optimistic.
  const missing = useFileStatus(file, !live) === "gone";
  const cls =
    "mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-muted/50 px-1.5 py-px align-baseline text-[0.85em] font-medium leading-tight text-foreground no-underline transition-colors hover:border-primary/40 hover:bg-hover";
  const inner = (
    <>
      <Icon className={`h-3.5 w-3.5 shrink-0 ${color}`} />
      <span className="truncate">{name}</span>
    </>
  );
  if (missing) {
    return (
      <Hint label={tw("notCreated")}>
        <span className={cn(cls, "cursor-default border-dashed text-muted-foreground/70 line-through opacity-70 hover:border-border hover:bg-hover")}>
          {inner}
        </span>
      </Hint>
    );
  }
  if (previewKind(name) !== null) {
    return (
      <Hint label={`/workspace/${rel}`}>
        <button type="button" onClick={() => open([file], 0)} className={cls}>
          {inner}
        </button>
      </Hint>
    );
  }
  return (
    <Hint label={`/workspace/${rel}`}>
      <a
        href={`/api/sandbox/files/download?chatId=${chatId}&path=${encodeURIComponent(rel)}`}
        download={name}
        className={cls}
      >
        {inner}
      </a>
    </Hint>
  );
}

/**
 * Markdown `components` for the chat transcript: render links the remark plugin
 * produced for `/workspace/` files as file chips, and the numbered links the
 * citations plugin produced as citation chips; everything else is a normal,
 * safe external link. Closes over chatId so the file chip can address the file.
 *
 * Citations are recognized by CONTENT (label is the source's number, href is
 * the source's url), not by the `data-citation` attribute the plugin also sets:
 * Streamdown sanitizes the tree with rehype-sanitize's default schema, which
 * strips data-* attributes before components ever see them.
 */
export function makeWorkspaceComponents(chatId?: string, live?: boolean, sources?: NumberedSource[]) {
  const byN = sources?.length ? new Map(sources.map((s) => [s.n, s])) : null;
  return {
    // The `node` prop react-markdown also passes is destructured away so it
    // never lands on the DOM element.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to keep react-markdown's AST handle off the DOM element
    a({ href, children, node: _node, ...rest }: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
      const rel = typeof href === "string" ? workspaceRelFromHref(href) : null;
      if (rel && chatId) return <WorkspacePathChip rel={rel} chatId={chatId} live={live} />;
      if (byN && typeof children === "string" && /^\d{1,4}$/.test(children)) {
        const source = byN.get(parseInt(children, 10));
        // Both matches exact, so the chip never changes what the model wrote:
        // canonical text equality keeps a hand-written "007" a plain link, and
        // URL equality keeps a model-authored [7](elsewhere) pointing elsewhere
        // instead of being silently redirected to the numbered source.
        if (source && String(source.n) === children && source.url === href) {
          return <CitationChip n={source.n} source={source} />;
        }
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow" {...rest}>
          {children}
        </a>
      );
    },
  };
}
