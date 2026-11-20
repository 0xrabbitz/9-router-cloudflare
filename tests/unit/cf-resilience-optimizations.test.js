import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unavailableResponse } from "../../open-sse/utils/error.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "../../open-sse/config/errorConfig.js";

describe("CF resilience and optimization regressions", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("@/sse/handlers/chat.js");
    vi.doUnmock("open-sse/translator/index.js");
    vi.doUnmock("@/lib/localDb");
    vi.doUnmock("@/lib/network/connectionProxy");
    vi.doUnmock("@/lib/db/driver.js");
    vi.doUnmock("@/lib/usageDb.js");
    vi.doUnmock("open-sse/utils/proxyFetch.js");
    vi.doUnmock("open-sse/handlers/chatCore.js");
    vi.doUnmock("@/sse/services/auth.js");
    vi.doUnmock("@/sse/services/model.js");
    vi.doUnmock("@/sse/services/keyAccess.js");
    vi.doUnmock("@/sse/services/tokenRefresh.js");
    vi.resetModules();
  });

  it("unavailableResponse guards invalid or missing retryAfter without NaN", async () => {
    const resInvalid = unavailableResponse(503, "[antigravity/gemini] Busy", "not-a-date", null);
    expect(resInvalid.status).toBe(503);
    expect(resInvalid.headers.get("Retry-After")).toBe("60");
    const bodyInvalid = await resInvalid.json();
    expect(bodyInvalid.error.message).toBe("[antigravity/gemini] Busy");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
    const future = "2026-10-01T00:00:15.000Z";
    const resValid = unavailableResponse(503, "Rate limited", future, "reset after 15s");
    expect(resValid.headers.get("Retry-After")).toBe("15");
    const bodyValid = await resValid.json();
    expect(bodyValid.error.message).toBe("Rate limited (reset after 15s)");
  });

  it("createStreamController propagates client signal abort and removes listener on complete", () => {
    const clientCtrl = new AbortController();
    const onDisconnect = vi.fn();
    const ctrl = createStreamController({
      provider: "antigravity",
      model: "gemini-4-hydrogen-high",
      signal: clientCtrl.signal,
      onDisconnect,
    });

    expect(ctrl.signal.aborted).toBe(false);
    clientCtrl.abort("timeout");
    expect(ctrl.signal.aborted).toBe(true);
    expect(onDisconnect).toHaveBeenCalledTimes(1);

    const clientCtrl2 = new AbortController();
    const onDisconnect2 = vi.fn();
    const ctrl2 = createStreamController({
      provider: "antigravity",
      model: "gemini-3.8-flash",
      signal: clientCtrl2.signal,
      onDisconnect: onDisconnect2,
    });
    ctrl2.handleComplete();
    clientCtrl2.abort("late-abort");
    expect(ctrl2.signal.aborted).toBe(false);
    expect(onDisconnect2).not.toHaveBeenCalled();
  });

  it("BaseExecutor.execute cancels retry backoff sleep immediately when client signal aborts", async () => {
    vi.resetModules();
    const fetchMock = vi.fn().mockResolvedValue({
      status: 503,
      headers: { get: () => "" },
    });
    vi.doMock("open-sse/utils/proxyFetch.js", () => ({
      proxyAwareFetch: (...args) => fetchMock(...args),
    }));

    const { BaseExecutor } = await import("../../open-sse/executors/base.js");
    const exec = new BaseExecutor("test", {
      baseUrl: "https://upstream.example/v1",
      retry: { 503: { attempts: 2, delayMs: 30_000 } },
    });

    const clientCtrl = new AbortController();
    setTimeout(() => clientCtrl.abort(), 20);

    const startedAt = Date.now();
    await expect(
      exec.execute({
        model: "test-model",
        body: {},
        stream: false,
        credentials: { apiKey: "k" },
        signal: clientCtrl.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("v1 chat/responses/messages routes catch unexpected failures instead of crashing worker", async () => {
    vi.resetModules();
    vi.doMock("open-sse/translator/index.js", async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        initTranslators: async () => {
          throw new Error("translator init failure");
        },
      };
    });
    vi.doMock("@/lib/localDb", () => ({
      getSettings: async () => ({ requireApiKey: false }),
      getProviderConnections: async () => [],
      validateApiKey: async () => true,
      updateProviderConnection: async () => {},
      getProxyPools: async () => [],
    }));

    const routes = await Promise.all([
      import("../../src/app/api/v1/chat/completions/route.js"),
      import("../../src/app/api/v1/responses/route.js"),
      import("../../src/app/api/v1/messages/route.js"),
    ]);

    for (const mod of routes) {
      const res = await mod.POST(
        new Request("http://localhost/v1/chat/completions", { method: "POST", body: "{}" })
      );
      expect(res.status).toBe(500);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      const json = await res.json();
      expect(json.error.message).toContain("translator init failure");
    }
  });

  it("handleChat stops immediately on client abort without marking account unavailable or falling back", async () => {
    vi.resetModules();
    const markAccountUnavailable = vi.fn();
    const getProviderCredentials = vi.fn().mockResolvedValue({
      connectionId: "ag-1",
      connectionName: "acct-1",
      accessToken: "tok",
      projectId: "proj-1",
      providerSpecificData: {},
    });
    const handleChatCore = vi.fn().mockResolvedValue({
      success: false,
      status: 499,
      error: "Request aborted",
      response: Response.json({ error: { message: "Request aborted" } }, { status: 499 }),
    });

    vi.doMock("@/lib/localDb", () => ({
      getSettings: async () => ({ requireApiKey: false }),
      getProviderConnections: async () => [],
      validateApiKey: async () => true,
      updateProviderConnection: async () => {},
      getProxyPools: async () => [],
    }));
    vi.doMock("@/sse/services/auth.js", () => ({
      getProviderCredentials,
      markAccountUnavailable,
      clearAccountError: vi.fn(),
      extractApiKey: () => null,
      isValidApiKey: async () => true,
    }));
    vi.doMock("@/sse/services/model.js", () => ({
      getModelInfo: async () => ({ provider: "antigravity", model: "gemini-4-hydrogen-high" }),
      getComboModels: async () => null,
    }));
    vi.doMock("@/sse/services/keyAccess.js", () => ({
      getKeyAccessContext: async () => null,
      enforceKeyAccess: async () => null,
      filterAdapterModels: async (_k, models) => models,
    }));
    vi.doMock("@/sse/services/tokenRefresh.js", () => ({
      checkAndRefreshToken: async (_p, c) => c,
      updateProviderCredentials: vi.fn(),
    }));
    vi.doMock("open-sse/handlers/chatCore.js", () => ({
      handleChatCore,
    }));

    const { handleChat } = await import("@/sse/handlers/chat.js");
    const ctrl = new AbortController();
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "ag/gemini-4-hydrogen-high", messages: [{ role: "user", content: "hi" }] }),
      signal: ctrl.signal,
    });
    ctrl.abort();
    const preAborted = await handleChat(req);
    expect(preAborted.status).toBe(499);
    expect(getProviderCredentials).not.toHaveBeenCalled();

    const ctrl2 = new AbortController();
    const req2 = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "ag/gemini-4-hydrogen-high", messages: [{ role: "user", content: "hi" }] }),
      signal: ctrl2.signal,
    });
    const res = await handleChat(req2);
    expect(res.status).toBe(499);
    expect(getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("round-robin skips DB write for single connection and modelScoped 404 keeps account active", async () => {
    vi.resetModules();
    const updateProviderConnection = vi.fn(async () => ({}));
    const getProviderConnections = vi.fn(async () => [
      { id: "ag-only", provider: "antigravity", isActive: true, lastUsedAt: "2026-10-01T00:00:00.000Z", consecutiveUseCount: 1 },
    ]);
    vi.doMock("@/lib/localDb", () => ({
      getProviderConnections,
      updateProviderConnection,
      getSettings: async () => ({
        providerStrategies: { antigravity: { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 1 } },
      }),
      getProxyPools: async () => [],
      validateApiKey: async () => true,
    }));
    vi.doMock("@/lib/network/connectionProxy", () => ({
      resolveConnectionProxyConfig: async () => ({}),
      pickProxyPoolId: vi.fn(),
    }));

    const { getProviderCredentials, markAccountUnavailable } = await import("@/sse/services/auth.js");
    const creds = await getProviderCredentials("antigravity", null, "gemini-4-hydrogen-high");
    expect(creds.connectionId).toBe("ag-only");
    expect(updateProviderConnection).not.toHaveBeenCalled();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
    const lockRes = await markAccountUnavailable(
      "ag-only",
      404,
      "Requested entity was not found.",
      "antigravity",
      "gemini-4-hydrogen-high"
    );
    expect(lockRes).toEqual({ shouldFallback: true, cooldownMs: MAX_RATE_LIMIT_COOLDOWN_MS });
    expect(updateProviderConnection).toHaveBeenCalledTimes(1);
    const patch = updateProviderConnection.mock.calls[0][1];
    expect(patch["modelLock_gemini-4-hydrogen-high"]).toBe(
      new Date(Date.now() + MAX_RATE_LIMIT_COOLDOWN_MS).toISOString()
    );
    expect(patch).not.toHaveProperty("testStatus");
  });

  it("createSSEStream skips content accumulation when captureContent=false without losing token usage", async () => {
    let completed = null;
    const stream = createSSEStream({
      mode: "passthrough",
      provider: "antigravity",
      model: "gemini-3.8-flash",
      body: { messages: [{ role: "user", content: "hello" }] },
      captureContent: false,
      onStreamComplete: (contentObj, usage) => {
        completed = { contentObj, usage };
      },
    });

    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const chunk =
      'data: {"id":"1","choices":[{"delta":{"content":"hello world","reasoning_content":"secret thought"}}]}\n\n' +
      'data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}\n\n' +
      "data: [DONE]\n\n";

    const readPromise = (async () => {
      const out = [];
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        out.push(dec.decode(value));
      }
      return out.join("");
    })();

    await writer.write(new TextEncoder().encode(chunk));
    await writer.close();
    const emitted = await readPromise;

    expect(emitted).toContain("hello world");
    expect(completed.contentObj).toEqual({ content: "", thinking: "" });
    expect(completed.usage).toMatchObject({ prompt_tokens: 12, completion_tokens: 4 });
  });

  it("handleChatCore skips saveRequestDetail when isObservabilityEnabled() returns false", async () => {
    vi.resetModules();
    const saveRequestDetail = vi.fn(async () => {});
    const isObservabilityEnabled = vi.fn(async () => false);
    const usageDbMock = {
      trackPendingRequest: vi.fn(),
      appendRequestLog: vi.fn(async () => {}),
      saveRequestDetail,
      saveRequestUsage: vi.fn(async () => {}),
      isObservabilityEnabled,
    };
    const ssePayload =
      'data: {"id":"1","choices":[{"delta":{"content":"pong"}}]}\n\n' +
      'data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n' +
      "data: [DONE]\n\n";

    vi.doMock("@/lib/usageDb.js", () => usageDbMock);
    vi.doMock("open-sse/utils/proxyFetch.js", () => ({
      default: vi.fn(),
      proxyAwareFetch: vi.fn(async () =>
        new Response(ssePayload, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      ),
    }));

    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const result = await handleChatCore({
      body: { model: "openai/gpt-4o", stream: true, messages: [{ role: "user", content: "ping" }] },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "sk-test" },
      sourceFormatOverride: FORMATS.OPENAI,
    });
    expect(result.success).toBe(true);
    const bodyText = await result.response.text();
    expect(bodyText).toContain("pong");
    expect(bodyText).toContain('"completion_tokens":2');
    expect(isObservabilityEnabled).toHaveBeenCalledTimes(1);
    expect(saveRequestDetail).not.toHaveBeenCalled();
  });

  it("settingsRepo, proxyPoolsRepo, and apiKeysRepo cache reads and invalidate immediately on mutation", async () => {
    vi.resetModules();
    let settingsData = JSON.stringify({ requireApiKey: true });
    let poolRow = {
      id: "pool-1",
      isActive: 1,
      testStatus: "ok",
      data: JSON.stringify({ name: "Main", proxyUrl: "http://1.2.3.4:8080", strictProxy: true }),
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    let keyRow = {
      id: "k1",
      key: "sk-cache-test",
      name: "Test",
      machineId: "m1",
      isActive: 1,
      createdAt: "2026-10-01T00:00:00.000Z",
      accessRestricted: 0,
      accessAllow: "[]",
    };

    const getCalls = { settings: 0, pool: 0, key: 0 };
    const fakeAdapter = {
      driver: "node-sqlite",
      async get(sql) {
        if (sql.includes("FROM settings")) {
          getCalls.settings++;
          return { data: settingsData };
        }
        if (sql.includes("FROM proxyPools")) {
          getCalls.pool++;
          return poolRow;
        }
        if (sql.includes("FROM apiKeys")) {
          getCalls.key++;
          return keyRow;
        }
        return undefined;
      },
      async all() {
        return [];
      },
      async run(sql, params) {
        if (sql.includes("INTO settings")) settingsData = params[0];
        if (sql.includes("INTO proxyPools")) poolRow = { ...poolRow, data: params[3] };
        if (sql.includes("UPDATE apiKeys")) keyRow = { ...keyRow, isActive: params[3] };
        return { changes: 1 };
      },
      async transaction(fn) {
        return await fn();
      },
    };

    vi.doMock("@/lib/db/driver.js", () => ({
      getAdapter: async () => fakeAdapter,
    }));

    const settingsRepo = await import("@/lib/db/repos/settingsRepo.js");
    const proxyPoolsRepo = await import("@/lib/db/repos/proxyPoolsRepo.js");
    const apiKeysRepo = await import("@/lib/db/repos/apiKeysRepo.js");

    await settingsRepo.getSettings();
    await settingsRepo.getSettings();
    expect(getCalls.settings).toBe(1);
    await settingsRepo.updateSettings({ requireApiKey: false });
    expect((await settingsRepo.getSettings()).requireApiKey).toBe(false);

    await proxyPoolsRepo.getProxyPoolById("pool-1");
    await proxyPoolsRepo.getProxyPoolById("pool-1");
    expect(getCalls.pool).toBe(1);
    await proxyPoolsRepo.updateProxyPool("pool-1", { proxyUrl: "http://5.6.7.8:8080" });
    expect((await proxyPoolsRepo.getProxyPoolById("pool-1")).proxyUrl).toBe("http://5.6.7.8:8080");

    expect(await apiKeysRepo.validateApiKey("sk-cache-test")).toBe(true);
    expect((await apiKeysRepo.getApiKeyByKey("sk-cache-test")).id).toBe("k1");
    expect(await apiKeysRepo.validateApiKey("sk-cache-test")).toBe(true);
    expect(getCalls.key).toBe(1);
    await apiKeysRepo.updateApiKey("k1", { isActive: false });
    expect(await apiKeysRepo.validateApiKey("sk-cache-test")).toBe(false);
  });
});
