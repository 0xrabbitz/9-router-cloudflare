// Polyfills for Cloudflare Workers (workerd) missing Web / Node globals
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
    constructor(cleanupCallback) {
      this.cleanupCallback = cleanupCallback;
    }
    register(target, heldValue, unregisterToken) {}
    unregister(unregisterToken) {
      return false;
    }
  };
}

if (typeof globalThis.WeakRef === "undefined") {
  globalThis.WeakRef = class WeakRef {
    constructor(target) {
      this.target = target;
    }
    deref() {
      return this.target;
    }
  };
}

if (typeof globalThis.BroadcastChannel === "undefined") {
  globalThis.BroadcastChannel = class BroadcastChannel {
    constructor(name) {
      this.name = name;
    }
    postMessage(message) {}
    close() {}
    addEventListener() {}
    removeEventListener() {}
  };
}
