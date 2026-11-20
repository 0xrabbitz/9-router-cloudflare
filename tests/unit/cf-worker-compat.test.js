import { afterEach, describe, expect, it, vi } from "vitest";
import { createTransactionRunner } from "@/lib/db/helpers/asyncTransaction.js";
import { createD1Adapter } from "@/lib/db/adapters/d1Adapter.js";
import { stripNullBytes } from "@/lib/db/helpers/nullBytes.js";

describe("Cloudflare Worker runtime compatibility", () => {
  afterEach(() => {
    delete globalThis.__D1_ADAPTER;
    delete globalThis.__9routerNativeFetch;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("isCloudflareWorker detects CF worker globals and stays false on Node", async () => {
    vi.resetModules();
    const { isCloudflareWorker } = await import("../../open-sse/utils/runtimeEnv.js");
    expect(isCloudflareWorker()).toBe(false);

    globalThis.__D1_ADAPTER = { driver: "cloudflare-d1" };
    expect(isCloudflareWorker()).toBe(true);
  });

  it("proxyAwareFetch uses native fetch without undici dispatcher on Cloudflare Workers", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      expect(init.dispatcher).toBeUndefined();
      expect(init.strictTls).toBeUndefined();
      expect(init.forceFreshSocket).toBeUndefined();
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    vi.resetModules();
    delete globalThis.__9routerNativeFetch;
    vi.stubGlobal("fetch", fetchMock);
    globalThis.__D1_ADAPTER = { driver: "cloudflare-d1" };

    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const res = await proxyAwareFetch("https://api.example.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      strictTls: true,
      forceFreshSocket: true,
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asyncTransaction serializes concurrent async transactions in order", async () => {
    const events = [];
    const runTx = createTransactionRunner((sql) => events.push(sql));

    let counter = 0;
    await Promise.all([
      runTx(async () => {
        const cur = counter;
        await new Promise((r) => setTimeout(r, 15));
        counter = cur + 1;
        events.push("op1");
      }),
      runTx(async () => {
        const cur = counter;
        await new Promise((r) => setTimeout(r, 5));
        counter = cur + 1;
        events.push("op2");
      }),
    ]);

    expect(counter).toBe(2);
    expect(events).toEqual([
      "BEGIN IMMEDIATE", "op1", "COMMIT",
      "BEGIN IMMEDIATE", "op2", "COMMIT",
    ]);
  });

  it("d1Adapter sanitizes undefined params and supports async transactions", async () => {
    const bound = [];
    const fakeD1 = {
      prepare(sql) {
        return {
          bind(...args) {
            bound.push({ sql, args });
            return {
              run: async () => ({ meta: { changes: 1, last_row_id: 1 } }),
              first: async () => null,
              all: async () => ({ results: [] }),
            };
          },
        };
      },
      exec: async () => {},
    };

    const adapter = createD1Adapter(fakeD1);
    const res = await adapter.run("INSERT INTO kv VALUES(?, ?, ?)", ["s", undefined, "v"]);
    expect(res.changes).toBe(1);
    expect(bound[0].args).toEqual(["s", null, "v"]);
    expect(stripNullBytes("a\0b\0c")).toBe("abc");

    const txOut = await adapter.transaction(async () => "done");
    expect(txOut).toBe("done");
  });

  it("runMigrationOnce skips D1 DDL when d1SchemaSig and table count match", async () => {
    const execCalls = [];
    const runCalls = [];
    const { TABLES, SCHEMA_VERSION } = await import("@/lib/db/schema.js");
    const sig = `v${SCHEMA_VERSION}:${Object.keys(TABLES).length}:${Object.values(TABLES).reduce(
      (sum, def) => sum + Object.keys(def.columns).length + (def.indexes?.length || 0),
      0
    )}`;

    const fakeD1 = {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              run: async () => { runCalls.push({ sql, args }); return { meta: { changes: 1 } }; },
              first: async () => ({ sig, cnt: Object.keys(TABLES).length }),
              all: async () => ({ results: [] }),
            };
          },
          run: async () => { runCalls.push({ sql, args: [] }); return { meta: { changes: 1 } }; },
          first: async () => ({ sig, cnt: Object.keys(TABLES).length }),
          all: async () => ({ results: [] }),
        };
      },
      exec: async (sql) => { execCalls.push(sql); },
    };

    const { runMigrationOnce } = await import("@/lib/db/migrate.js");
    const adapter = createD1Adapter(fakeD1);
    await runMigrationOnce(adapter);

    expect(execCalls).toEqual([]);
    expect(runCalls).toEqual([]);
  });

  it("runMigrationOnce batches D1 table and index DDL and stamps d1SchemaSig on cold DB", async () => {
    const execCalls = [];
    const runCalls = [];
    const { TABLES, SCHEMA_VERSION } = await import("@/lib/db/schema.js");
    const expectedSig = `v${SCHEMA_VERSION}:${Object.keys(TABLES).length}:${Object.values(TABLES).reduce(
      (sum, def) => sum + Object.keys(def.columns).length + (def.indexes?.length || 0),
      0
    )}`;

    const fakeD1 = {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              run: async () => { runCalls.push({ sql, args }); return { meta: { changes: 1 } }; },
              first: async () => { throw new Error("no such table: _meta"); },
              all: async () => ({ results: [] }),
            };
          },
          run: async () => { runCalls.push({ sql, args: [] }); return { meta: { changes: 1 } }; },
          first: async () => { throw new Error("no such table: _meta"); },
          all: async () => ({ results: [] }),
        };
      },
      exec: async (sql) => { execCalls.push(sql); },
    };

    const { runMigrationOnce } = await import("@/lib/db/migrate.js");
    const adapter = createD1Adapter(fakeD1);
    await runMigrationOnce(adapter);

    // 1 batched exec for tables + 1 batched exec for indexes
    expect(execCalls.length).toBe(2);
    expect(execCalls[0]).toContain("CREATE TABLE IF NOT EXISTS");
    expect(execCalls[1]).toContain("CREATE INDEX IF NOT EXISTS");
    expect(runCalls).toContainEqual(expect.objectContaining({ args: [expectedSig] }));
  });
});
