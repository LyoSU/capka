import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../../../../messages/en.json";

/**
 * A tap on a card whose request is no longer current (the chat moved past it, the
 * branch was switched in another tab) is answered "gone". The buttons used to come
 * back with nothing said, and every further tap was refused again until a manual
 * reload. Now the card says so, keeps its buttons down and reloads the chat.
 *
 * The cards are mounted for real and tapped: the repo has no DOM library, so a
 * minimal node stands in for one — enough for React to build the tree and route a
 * click to its handler. The UI primitives are swapped for plain elements so the
 * card's own logic is what runs.
 */
vi.mock("@/components/ui/button", async () => {
  const { createElement } = await import("react");
  return { Button: (p: Record<string, unknown>) => createElement("button", p) };
});
vi.mock("@/components/ui/input", async () => {
  const { createElement } = await import("react");
  return { Input: (p: Record<string, unknown>) => createElement("input", p) };
});

import { ApprovalCard } from "../manage-cards";
import { AskCard } from "../ask-card";

class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  attributes: Record<string, string> = {};
  listeners: { type: string; fn: (e: unknown) => void; capture: boolean }[] = [];
  style = { setProperty() {}, removeProperty() {} };
  namespaceURI = "http://www.w3.org/1999/xhtml";
  constructor(public nodeType: number, public nodeName: string, public ownerDocument: unknown, public nodeValue: string | null = null) {}
  get tagName() { return this.nodeName; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get textContent(): string { return this.nodeType === 3 ? this.nodeValue ?? "" : this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(text: string) {
    this.childNodes = [];
    if (text) this.appendChild(new FakeNode(3, "#text", this.ownerDocument, text));
  }
  appendChild(c: FakeNode) { return this.insertBefore(c, null); }
  insertBefore(c: FakeNode, before: FakeNode | null) {
    c.parentNode?.removeChild(c);
    const at = before ? this.childNodes.indexOf(before) : -1;
    if (at < 0) this.childNodes.push(c); else this.childNodes.splice(at, 0, c);
    c.parentNode = this;
    return c;
  }
  removeChild(c: FakeNode) { this.childNodes = this.childNodes.filter((x) => x !== c); c.parentNode = null; return c; }
  setAttribute(k: string, v: string) { this.attributes[k] = String(v); }
  setAttributeNS(_ns: string, k: string, v: string) { this.setAttribute(k, v); }
  removeAttribute(k: string) { delete this.attributes[k]; }
  getAttribute(k: string) { return this.attributes[k] ?? null; }
  hasAttribute(k: string) { return k in this.attributes; }
  addEventListener(type: string, fn: (e: unknown) => void, opt?: boolean | { capture?: boolean }) {
    this.listeners.push({ type, fn, capture: typeof opt === "boolean" ? opt : !!opt?.capture });
  }
  removeEventListener() {}
  all(): FakeNode[] { return [this, ...this.childNodes.flatMap((c) => c.all())]; }
}

const doc = {
  nodeType: 9, body: null, activeElement: null, addEventListener() {}, removeEventListener() {},
  createElement: (tag: string) => new FakeNode(1, tag.toUpperCase(), doc),
  createElementNS: (ns: string, tag: string) => Object.assign(new FakeNode(1, tag, doc), { namespaceURI: ns }),
  createTextNode: (text: string) => new FakeNode(3, "#text", doc, text),
};

let container: FakeNode;
let root: Root;
let reloads: number;
let posts: string[];
let reply: Record<string, unknown>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("window", { HTMLIFrameElement: class {}, event: undefined });
  vi.stubGlobal("fetch", async (url: string) => { posts.push(url); return Response.json(reply); });
  container = new FakeNode(1, "DIV", doc);
  root = createRoot(container as unknown as HTMLElement);
  reloads = 0;
  posts = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
const mount = async (card: ReturnType<typeof createElement>) => {
  // eslint-disable-next-line react/no-children-prop
  await act(async () => { root.render(createElement(NextIntlClientProvider, { locale: "en", messages: en, children: card })); });
};
const button = (label: string) => container.all().find((n) => n.nodeName === "BUTTON" && n.textContent === label)!;
/** A click as the browser delivers it: the root's capture listeners, then its bubble ones. */
const tap = async (label: string) => {
  const target = button(label);
  const event = { type: "click", target, bubbles: true, cancelable: true, timeStamp: 0, defaultPrevented: false, preventDefault() {}, stopPropagation() {} };
  await act(async () => {
    for (const capture of [true, false]) {
      for (const l of container.listeners.filter((x) => x.type === "click" && x.capture === capture)) l.fn(event);
    }
  });
  await settle();
};

describe("a decision on a request that is no longer current", () => {
  const approval = () => createElement(ApprovalCard, {
    messageId: "m1", toolCallId: "c1", toolName: "mcp__gmail__send", input: {},
    state: "approval-requested", approval: { id: "a1" }, onReload: () => { reloads++; },
  });
  const ask = () => createElement(AskCard, {
    messageId: "m1", toolCallId: "c1", state: "input-available",
    form: { fields: [{ id: "f", label: "Which file?", kind: "text" }] }, onReload: () => { reloads++; },
  });

  it("an approval card says so, keeps its buttons down and reloads the chat", async () => {
    reply = { ok: false, outcome: "gone" };
    await mount(approval());
    await tap(en.chat.approval.allow);
    expect(posts).toEqual(["/api/manage/approve"]);
    expect(reloads).toBe(1);
    expect(container.textContent).toContain(en.chat.approval.gone);
    expect(button(en.chat.approval.allow).hasAttribute("disabled")).toBe(true);
    expect(button(en.chat.approval.decline).hasAttribute("disabled")).toBe(true);
    // A second tap goes nowhere: nothing to retry.
    await tap(en.chat.approval.decline);
    expect(posts).toHaveLength(1);
  });

  it("a question card says so, keeps its buttons down and reloads the chat", async () => {
    reply = { ok: false, outcome: "gone" };
    await mount(ask());
    await tap(en.chat.ask.skip);
    expect(posts).toEqual(["/api/ask/answer"]);
    expect(reloads).toBe(1);
    expect(container.textContent).toContain(en.chat.ask.gone);
    expect(button(en.chat.ask.skip).hasAttribute("disabled")).toBe(true);
  });

  it("an outcome this build does not know still brings the buttons back, without a reload", async () => {
    reply = { ok: false, outcome: "later-outcome" };
    await mount(approval());
    await tap(en.chat.approval.allow);
    expect(reloads).toBe(0);
    expect(button(en.chat.approval.allow).hasAttribute("disabled")).toBe(false);
    expect(container.textContent).not.toContain(en.chat.approval.gone);
  });
});
