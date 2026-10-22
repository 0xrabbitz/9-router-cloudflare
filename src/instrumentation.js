import "@/lib/edgePolyfills.js";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
      initConsoleLogCapture();
    } catch {}

    try {
      const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
      await installCatalogSource();
    } catch {}

    // Only start persistent sync daemon on non-serverless node runtime
    if (!process.env.CF_PAGES && !process.env.WORKERS_ENV) {
      try {
        const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
        startModelCatalogSync();
      } catch {}
    }
  }
}
