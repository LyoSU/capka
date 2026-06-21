"use client";

import type { ComponentPropsWithoutRef } from "react";
import { useTranslations } from "next-intl";
import { visit, SKIP } from "unist-util-visit";
import type { Root, RootContent } from "mdast";
import { usePreview, useFileStatus, type PreviewFile } from "./file-preview";
import { fileKind, previewKind } from "@/lib/file-kinds";
import { WORKSPACE_PATH_RE, isSafeWorkspaceRel, workspaceRelFromHref } from "@/lib/chat/artifacts";
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
        // Fresh regex — WORKSPACE_PATH_RE is global and carries lastIndex state.
        const re = new RegExp(WORKSPACE_PATH_RE.source, "g");
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
    "mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md border border-border/60 bg-muted/50 px-1.5 py-px align-baseline text-[0.85em] font-medium leading-tight text-foreground no-underline transition-colors hover:border-primary/40 hover:bg-accent";
  const inner = (
    <>
      <Icon className={`h-3.5 w-3.5 shrink-0 ${color}`} />
      <span className="truncate">{name}</span>
    </>
  );
  if (missing) {
    return (
      <span
        title={tw("notCreated")}
        className={cn(cls, "cursor-default border-dashed text-muted-foreground/70 line-through opacity-70 hover:border-border/60 hover:bg-muted/50")}
      >
        {inner}
      </span>
    );
  }
  if (previewKind(name) !== null) {
    return (
      <button type="button" title={`/workspace/${rel}`} onClick={() => open([file], 0)} className={cls}>
        {inner}
      </button>
    );
  }
  return (
    <a
      href={`/api/sandbox/files/download?chatId=${chatId}&path=${encodeURIComponent(rel)}`}
      download={name}
      title={`/workspace/${rel}`}
      className={cls}
    >
      {inner}
    </a>
  );
}

/**
 * Markdown `components` for the chat transcript: render links the remark plugin
 * produced for `/workspace/` files as file chips; everything else is a normal,
 * safe external link. Closes over chatId so the chip can address the file.
 */
export function makeWorkspaceComponents(chatId: string, live?: boolean) {
  return {
    // Only href + children are read; the `node` prop react-markdown also passes
    // is intentionally ignored so it never lands on the DOM element.
    a({ href, children }: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
      const rel = typeof href === "string" ? workspaceRelFromHref(href) : null;
      if (rel) return <WorkspacePathChip rel={rel} chatId={chatId} live={live} />;
      return (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow">
          {children}
        </a>
      );
    },
  };
}
