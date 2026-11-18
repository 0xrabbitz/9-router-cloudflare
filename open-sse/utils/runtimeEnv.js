/**
 * Detect Cloudflare Workers (`workerd`) runtime so edge-incompatible Node
 * transport APIs (undici Agent/ALPNProtocols, wreq-js native bindings, local
 * /etc/hosts MITM socket bypasses) can cleanly delegate to native Workers fetch.
 */
export function isCloudflareWorker() {
  return (
    (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers")
    || (typeof globalThis !== "undefined" && (
      !!globalThis[Symbol.for("__cloudflare-context__")]
      || !!globalThis.__D1_ADAPTER
    ))
  );
}
