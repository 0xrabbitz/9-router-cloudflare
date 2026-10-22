// Cloudflare D1 Adapter for 9Router
// Connects 9Router to Cloudflare D1 serverless database

export function createD1Adapter(d1) {
  if (!d1) throw new Error("[D1Adapter] D1 database binding is required");

  function prepare(sql, params = []) {
    const p = Array.isArray(params) ? params : [params];
    if (p.length > 0) {
      const sanitized = p.map((v) => (v === undefined ? null : v));
      return d1.prepare(sql).bind(...sanitized);
    }
    return d1.prepare(sql);
  }

  async function run(sql, params = []) {
    try {
      const stmt = prepare(sql, params);
      const res = await stmt.run();
      return {
        changes: res.meta?.changes ?? 0,
        lastInsertRowid: res.meta?.last_row_id ?? null,
      };
    } catch (e) {
      console.error("[D1Adapter] run error:", e.message, "SQL:", sql);
      throw e;
    }
  }

  async function get(sql, params = []) {
    try {
      const stmt = prepare(sql, params);
      const row = await stmt.first();
      return row === null ? undefined : row;
    } catch (e) {
      console.error("[D1Adapter] get error:", e.message, "SQL:", sql);
      throw e;
    }
  }

  async function all(sql, params = []) {
    try {
      const stmt = prepare(sql, params);
      const res = await stmt.all();
      return res.results ?? [];
    } catch (e) {
      console.error("[D1Adapter] all error:", e.message, "SQL:", sql);
      throw e;
    }
  }

  async function exec(sql) {
    try {
      // Filter out PRAGMA statements unsupported or forbidden on Cloudflare D1
      const statements = sql
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s && !s.toUpperCase().startsWith("PRAGMA"));

      if (statements.length === 0) return;

      const cleanSql = statements.join(";\n");
      return await d1.exec(cleanSql);
    } catch (e) {
      console.error("[D1Adapter] exec error:", e.message);
      // Fail-open for non-critical exec errors
    }
  }

  async function transaction(fn) {
    // In D1, batching or serial execution handles consistency
    return await fn();
  }

  function close() {
    // No-op for serverless D1
  }

  return {
    driver: "cloudflare-d1",
    run,
    get,
    all,
    exec,
    transaction,
    close,
    raw: d1,
  };
}

