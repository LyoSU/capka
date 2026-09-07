import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { MAX_REDACTION_PAIRS } from "@/lib/chat/secrets";

/**
 * The two loaders, and the rules they enforce that the API's validators cannot.
 *
 * `loadRedactionSecrets` answers "which values must not appear in this run's output". The
 * scope is the WORKSPACE, not the chat: a sandbox session is keyed by `projectId ?? chatId`,
 * so every chat in a project shares one `/workspace`; a background job started by chat A
 * inherits A's secret env and tees its raw output into `/workspace/.capka/jobs/<id>/log`
 * there, and chat B reads that file with an ordinary tool call. Two things about the query
 * are load-bearing and invisible from the returned array: it must join `chats` and match
 * the session key against BOTH `project_id` and `id` (the key is one or the other), and it
 * must stay inside one owner. So the suite asserts on the SQL as well as on the mapping.
 *
 * `loadSecretEnv` is the injection side, and it re-checks the storage floor because the
 * validator only ever guarded new writes — a row saved before the floor existed was still
 * injected into the container and still skipped by the redactor, which is exactly the
 * combination the floor was introduced to make impossible.
 */
const captured = vi.hoisted(() => ({
  where: undefined as unknown,
  joined: [] as string[],
  limit: undefined as number | undefined,
  rows: [] as { name: string; valueEnc: string }[],
  warns: [] as { msg: string; ctx: Record<string, unknown> }[],
}));

vi.mock("@/lib/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  // `loadSecretEnv` awaits the builder at `.where()`; `loadRedactionSecrets` continues
  // into `.orderBy().limit()`. Drizzle's real builder is both a chain and a promise, so
  // the fake has to be too, or one of the two callers hangs on an object with no `then`.
  const tail = (): Record<string, unknown> => ({
    orderBy: () => tail(),
    limit: (n: number) => {
      captured.limit = n;
      return Promise.resolve(captured.rows.slice(0, n));
    },
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(captured.rows).then(res, rej),
  });
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.innerJoin = (table: never) => {
    captured.joined.push(getTableName(table));
    return chain;
  };
  chain.where = (w: unknown) => {
    captured.where = w;
    return tail();
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
vi.mock("@/lib/log", () => ({
  log: {
    warn: (msg: string, ctx: Record<string, unknown>) => captured.warns.push({ msg, ctx }),
    info: () => {},
    error: () => {},
  },
}));

import { loadRedactionSecrets, loadSecretEnv } from "@/lib/chat/secrets";

const rendered = () => new PgDialect().sqlToQuery(captured.where as never);

beforeEach(() => {
  captured.where = undefined;
  captured.joined = [];
  captured.limit = undefined;
  captured.rows = [];
  captured.warns = [];
});

describe("loadRedactionSecrets", () => {
  it("scopes to every chat sharing the workspace session key, within one owner", async () => {
    captured.rows = [{ name: "TOKEN", valueEnc: "enc:sk-live-value" }];

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

  it("bounds the union and says so when it cuts", async () => {
    // Nothing bounds how many chats a project holds, and every pair costs several
    // full-string passes over EVERY tool result. One row past the bound is fetched so
    // the cut is a fact rather than an inference from a full page.
    captured.rows = Array.from({ length: MAX_REDACTION_PAIRS + 50 }, (_, i) => ({
      name: `K${i}`,
      valueEnc: `enc:sk-live-value-${i}`,
    }));

    const pairs = await loadRedactionSecrets("p1", "u1");

    expect(captured.limit).toBe(MAX_REDACTION_PAIRS + 1);
    expect(pairs).toHaveLength(MAX_REDACTION_PAIRS);
    expect(captured.warns.map((w) => w.msg)).toContain(
      "workspace has more secrets than the redactor covers; oldest are not redacted",
    );
  });

  it("says nothing when the workspace fits inside the bound", async () => {
    captured.rows = Array.from({ length: MAX_REDACTION_PAIRS }, (_, i) => ({
      name: `K${i}`,
      valueEnc: `enc:sk-live-value-${i}`,
    }));

    expect(await loadRedactionSecrets("p1", "u1")).toHaveLength(MAX_REDACTION_PAIRS);
    expect(captured.warns).toEqual([]);
  });

  it("spends the bound only on pairs that can redact something", async () => {
    // A pre-floor row would occupy a slot and redact nothing.
    captured.rows = [
      { name: "LEGACY", valueEnc: "enc:abc" },
      { name: "LIVE", valueEnc: "enc:sk-live-value" },
    ];

    expect(await loadRedactionSecrets("p1", "u1")).toEqual([["LIVE", "sk-live-value"]]);
  });
});

describe("loadSecretEnv", () => {
  it("injects a value the redactor covers", async () => {
    captured.rows = [{ name: "TOKEN", valueEnc: "enc:sk-live-value" }];
    expect(await loadSecretEnv("c1")).toEqual({ TOKEN: "sk-live-value" });
  });

  it("does NOT inject a value stored before the floor existed", async () => {
    // The whole point of the floor: such a value reached the container's environment and
    // then went straight into the transcript, because the redactor skips it. The API
    // refuses to store one now; the table may still hold one from before it did.
    captured.rows = [
      { name: "LEGACY", valueEnc: "enc:abc" },
      { name: "LIVE", valueEnc: "enc:sk-live-value" },
    ];

    expect(await loadSecretEnv("c1")).toEqual({ LIVE: "sk-live-value" });
  });

  it("does NOT inject a value the redactor would throw on", async () => {
    // A lone surrogate: `encodeURIComponent` rejects it, and its byte encodings describe
    // a replacement character rather than the string that was injected.
    captured.rows = [{ name: "BROKEN", valueEnc: "enc:\ud800abc" }];
    expect(await loadSecretEnv("c1")).toEqual({});
  });

  it("reports the skipped names once per load, with no value and no length", async () => {
    // This runs on the first command of every turn. A line per row would flood the log.
    captured.rows = [
      { name: "L1", valueEnc: "enc:abc" },
      { name: "L2", valueEnc: "enc:xy" },
      { name: "LIVE", valueEnc: "enc:sk-live-value" },
    ];

    await loadSecretEnv("c1");

    const floorWarns = captured.warns.filter((w) => w.msg.includes("below the redaction floor"));
    expect(floorWarns).toHaveLength(1);
    expect(floorWarns[0].ctx).toMatchObject({ chatId: "c1", names: "L1,L2" });
    expect(JSON.stringify(floorWarns[0].ctx)).not.toContain("abc");
  });

  it("still skips an undecryptable row without touching the others", async () => {
    captured.rows = [
      { name: "STALE", valueEnc: "__broken__" },
      { name: "LIVE", valueEnc: "enc:sk-live-value" },
    ];
    expect(await loadSecretEnv("c1")).toEqual({ LIVE: "sk-live-value" });
  });
});
