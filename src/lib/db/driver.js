import { ensureDirs, DATA_FILE } from "./paths.js";

// Use global to survive Next.js dev hot-reload (module state resets on reload)
if (!global._dbAdapter) global._dbAdapter = { instance: null, initPromise: null, logged: false };
const state = global._dbAdapter;

async function tryD1() {
  if (globalThis.__D1_ADAPTER) return globalThis.__D1_ADAPTER;
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const ctx = await getCloudflareContext({ async: true });
    if (ctx?.env?.DB) {
      const { createD1Adapter } = await import("./adapters/d1Adapter.js");
      const adapter = createD1Adapter(ctx.env.DB);
      globalThis.__D1_ADAPTER = adapter;
      return adapter;
    }
  } catch (e) {
    // Cloudflare context unavailable (e.g. running outside worker request)
  }
  return null;
}

async function tryBunSqlite() {
  return null;
}

async function tryBetterSqlite() {
  if (process.versions?.bun) return null;
  const [nodeMajor] = (process.versions?.node || "20").split(".").map(Number);
  if (nodeMajor >= 24) return null;
  try {
    const { createBetterSqliteAdapter } = await import("./adapters/betterSqliteAdapter.js");
    return createBetterSqliteAdapter(DATA_FILE);
  } catch (e) {
    return null;
  }
}

async function tryNodeSqlite() {
  if (process.versions?.bun) return null;
  const [maj, min] = (process.versions?.node || "20").split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) return null;
  try {
    const { createNodeSqliteAdapter } = await import("./adapters/nodeSqliteAdapter.js");
    return await createNodeSqliteAdapter(DATA_FILE);
  } catch (e) {
    return null;
  }
}

async function trySqlJs() {
  try {
    const { createSqlJsAdapter } = await import("./adapters/sqljsAdapter.js");
    return await createSqlJsAdapter(DATA_FILE);
  } catch (e) {
    return null;
  }
}

async function initAdapter() {
  ensureDirs();
  let adapter = await tryD1();
  if (!adapter) adapter = await tryBetterSqlite();
  if (!adapter) adapter = await tryNodeSqlite();
  if (!adapter) adapter = await trySqlJs();
  if (!adapter) throw new Error("[DB] No SQLite/D1 driver available");

  if (!state.logged) {
    console.log(`[DB] Driver: ${adapter.driver}`);
    state.logged = true;
  }

  const { runMigrationOnce } = await import("./migrate.js");
  await runMigrationOnce(adapter);
  return adapter;
}

export async function getAdapter() {
  if (globalThis.__D1_ADAPTER) return globalThis.__D1_ADAPTER;

  // On Cloudflare Worker, fetch D1 dynamically per request context if not set
  const d1 = await tryD1();
  if (d1) {
    if (!state.logged) {
      console.log(`[DB] Driver: ${d1.driver}`);
      state.logged = true;
    }
    const { runMigrationOnce } = await import("./migrate.js");
    await runMigrationOnce(d1);
    return d1;
  }

  if (state.instance) return state.instance;
  if (!state.initPromise) state.initPromise = initAdapter().then((a) => { state.instance = a; return a; });
  return state.initPromise;
}

export function getAdapterSync() {
  if (globalThis.__D1_ADAPTER) return globalThis.__D1_ADAPTER;
  if (!state.instance) throw new Error("[DB] adapter not initialized — await getAdapter() first");
  return state.instance;
}
