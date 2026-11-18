import fs from "node:fs";
import path from "node:path";

const targetPath = path.resolve("node_modules/@opennextjs/cloudflare/dist/cli/templates/init.js");
if (fs.existsSync(targetPath)) {
  let content = fs.readFileSync(targetPath, "utf-8");
  if (!content.includes("globalThis.MessagePort")) {
    const polyfill = `// Polyfills for workerd missing globals
if (typeof globalThis.MessagePort === "undefined") {
  globalThis.MessagePort = class MessagePort {};
}
if (typeof globalThis.MessageChannel === "undefined") {
  globalThis.MessageChannel = class MessageChannel {
    constructor() {
      this.port1 = new globalThis.MessagePort();
      this.port2 = new globalThis.MessagePort();
    }
  };
}
if (typeof globalThis.FinalizationRegistry === "undefined") {
  globalThis.FinalizationRegistry = class FinalizationRegistry {
    constructor(cleanupCallback) { this.cleanupCallback = cleanupCallback; }
    register() {}
    unregister() { return false; }
  };
}
if (typeof globalThis.WeakRef === "undefined") {
  globalThis.WeakRef = class WeakRef {
    constructor(target) { this.target = target; }
    deref() { return this.target; }
  };
}
if (typeof globalThis.BroadcastChannel === "undefined") {
  globalThis.BroadcastChannel = class BroadcastChannel {
    constructor(name) { this.name = name; }
    postMessage() {}
    close() {}
    addEventListener() {}
    removeEventListener() {}
  };
}
`;
    fs.writeFileSync(targetPath, polyfill + content, "utf-8");
    console.log("[patch-opennext] Applied workerd polyfills to @opennextjs/cloudflare template");
  }
}

const workerPath = path.resolve("node_modules/@opennextjs/cloudflare/dist/cli/templates/worker.js");
if (fs.existsSync(workerPath)) {
  let workerContent = fs.readFileSync(workerPath, "utf-8");
  if (!workerContent.includes("async scheduled(")) {
    const scheduledMethod = `    async scheduled(event, env, ctx) {
        console.log(\`[Cron] Scheduled trigger fired (\${event.cron}) at \${new Date().toISOString()}\`);
        ctx.waitUntil((async () => {
            try {
                console.log("[Cron] Background maintenance tick executed successfully.");
            } catch (err) {
                console.error("[Cron] Scheduled maintenance error:", err);
            }
        })());
    },
};`;
    if (workerContent.trimEnd().endsWith("};")) {
      workerContent = workerContent.replace(/};\s*$/, `${scheduledMethod}\n`);
      fs.writeFileSync(workerPath, workerContent, "utf-8");
      console.log("[patch-opennext] Added scheduled() cron handler to @opennextjs/cloudflare worker template");
    }
  }
}

