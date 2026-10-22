/**
 * Safely schedule a background task across Node.js, Bun, and Cloudflare Workers.
 * On Cloudflare Workers, passes the promise to ExecutionContext.waitUntil() so the
 * runtime keeps the isolate alive until DB writes complete.
 */
export function runBackground(promise) {
  if (!promise || typeof promise.then !== "function") return;

  const caught = promise.catch((err) => {
    console.error("[Background Task Error]", err?.message || err);
  });

  // 1. Check Cloudflare Worker ExecutionContext from AsyncLocalStorage / global
  try {
    const globalContext = globalThis[Symbol.for("__cloudflare-context__")];
    if (globalContext?.ctx?.waitUntil) {
      globalContext.ctx.waitUntil(caught);
      return;
    }
  } catch {}

  // 2. Check globalThis.waitUntil (some edge runtimes)
  try {
    if (typeof globalThis.waitUntil === "function") {
      globalThis.waitUntil(caught);
      return;
    }
  } catch {}
}
