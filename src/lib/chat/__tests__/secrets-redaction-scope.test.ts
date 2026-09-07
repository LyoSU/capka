import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * `loadRedactionSecrets` answers "which values must not appear in this run's output".
 *
 * The scope is the WORKSPACE, not the chat. A sandbox session is keyed by
 * `projectId ?? chatId`, so every chat in a project shares one `/workspace`; a background
 * job started by chat A inherits A's secret env and tees its raw output into
 * `/workspace/.capka/jobs/<id>/log` there, and chat B reads that file with an ordinary tool call.
 * Two things about the query are load-bearing and invisible from the returned array: it
 * must join `chats` and match the session key against BOTH `project_id` and `id` (the key
 * is one or the other), and it must stay inside one owner. So the suite asserts on the SQL
 * as well as on the mapping.
 */
const captured = vi.hoisted(() => ({
  where: undefined as unknown,
  joined: [] as string[],
  rows: [] as { name: string; valueEnc: string }[],
}));

vi.mock("@/lib/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.innerJoin = (table: never) => {
    captured.joined.push(getTableName(table));
    return chain;
  };
  chain.where = (w: unknown) => {
    captured.where = w;
    return Promise.resolve(captured.rows);
  };
  return { db: { select: () => chain } };
});

// The master key is an instance setting behind a DB read; the cipher is not what this
// suite is about, so `decrypt` is the identity except for one row that refuses.
vi.mock("@/lib/settings", () => ({ getMasterKey: () => Promise.resolve("k") }));
vi.mock("@/lib/crypto", () => ({
  encrypt: (v: string) => v,
  decrypt: (v: string) => {
    if (v === "__broken__") throw new Error("bad ciphertext");
    return v.replace(/^enc:/, "");
  },
}));

import { loadRedactionSecrets } from "@/lib/chat/secrets";

const rendered = () => new PgDialect().sqlToQuery(captured.where as never);

beforeEach(() => {
  captured.where = undefined;
  captured.joined = [];
  captured.rows = [];
});

describe("loadRedactionSecrets", () => {
  it("scopes to every chat sharing the workspace session key, within one owner", async () => {
    captured.rows = [{ name: "TOKEN", valueEnc: "enc:v1" }];

    await loadRedactionSecrets("p1", "u1");

    // Without the join there is no way to reach a sibling chat's rows at all: the
    // secrets table only knows chat ids, and the session key may be a project id.
    expect(captured.joined).toContain("chats");
    const { sql, params } = rendered();
    // The session key is a project id for a chat in a project and the chat's own id
    // otherwise, so both columns have to be tried — matching only one leaves either
    // project chats or bare chats unprotected.
    expect(sql).toContain('"chats"."project_id"');
    expect(sql).toContain('"chats"."id"');
    // A project has exactly one owner (`projects.user_id` is NOT NULL) and /api/chat
    // refuses to retarget a chat into another owner's project, so this predicate is
    // belt-and-braces — but it is the reason a future write site cannot widen the union
    // into someone else's credentials.
    expect(sql).toContain('"chats"."user_id"');
    expect(params).toContain("u1");
    expect(params).toContain("p1");
  });

  it("returns PAIRS, so two chats' same-named secrets both survive", async () => {
    // Chat A and chat B in one project each store a `TOKEN`. A `Record<string, string>`
    // would keep one value and hand the model the other in plaintext.
    captured.rows = [
      { name: "TOKEN", valueEnc: "enc:sk-chat-a-value" },
      { name: "TOKEN", valueEnc: "enc:sk-chat-b-value" },
    ];

    expect(await loadRedactionSecrets("p1", "u1")).toEqual([
      ["TOKEN", "sk-chat-a-value"],
      ["TOKEN", "sk-chat-b-value"],
    ]);
  });

  it("skips a row it cannot decrypt instead of failing the turn", async () => {
    // Same rule as `loadSecretEnv`: a master key rotated out from under one stale row
    // must not take every command in the workspace down with it.
    captured.rows = [
      { name: "STALE", valueEnc: "__broken__" },
      { name: "LIVE", valueEnc: "enc:sk-live-value" },
    ];

    expect(await loadRedactionSecrets("c1", "u1")).toEqual([["LIVE", "sk-live-value"]]);
  });

  it("does no key work for a workspace with no secrets", async () => {
    // The overwhelmingly common case. It must not pay a settings read per turn.
    expect(await loadRedactionSecrets("c1", "u1")).toEqual([]);
  });
});
