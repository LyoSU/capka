import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { inIds } from "./in-ids";

describe("inIds", () => {
  it("binds the ids as one parameter however many there are", () => {
    const ids = Array.from({ length: 70000 }, (_, i) => `m${i}`);
    const q = new PgDialect().sqlToQuery(inIds(sql`origin ->> 'messageId'`, ids));
    expect(q.params).toEqual([ids]);
    expect(q.sql).toBe("origin ->> 'messageId' = ANY($1::text[])");
  });
});
