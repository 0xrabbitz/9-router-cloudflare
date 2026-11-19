import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  getApiKeys: vi.fn(),
  getConsistentMachineId: vi.fn(),
  refreshGoogleToken: vi.fn(),
  updateProviderCredentials: vi.fn(),
  handleChat: vi.fn(),
  initTranslators: vi.fn(),
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  getApiKeys: mocks.getApiKeys,
}));
vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));
vi.mock("@/sse/services/tokenRefresh", () => ({
  refreshGoogleToken: mocks.refreshGoogleToken,
  refreshCodexToken: vi.fn(),
  updateProviderCredentials: mocks.updateProviderCredentials,
}));
vi.mock("@/sse/handlers/chat.js", () => ({
  handleChat: mocks.handleChat,
}));
vi.mock("open-sse/translator/index.js", () => ({
  initTranslators: mocks.initTranslators,
}));
vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

const originalFetch = global.fetch;

describe("Antigravity live catalog & Cloudflare Worker model ping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getApiKeys.mockResolvedValue([{ key: "sk-test", isActive: true }]);
    mocks.getConsistentMachineId.mockResolvedValue("cli-tok");
    mocks.initTranslators.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete globalThis.__D1_ADAPTER;
    global.fetch = originalFetch;
  });

  it("queries fetchAvailableModels with Hub headers, filters disabled/internal rows, and refreshes on 401", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-ag-1",
      provider: "antigravity",
      accessToken: "expired-tok",
      refreshToken: "rt-1",
    });
    mocks.refreshGoogleToken.mockResolvedValue({
      accessToken: "fresh-tok",
      refreshToken: "rt-1",
      expiresIn: 3600,
    });

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        models: {
          "gemini-4-hydrogen-xhigh": { displayName: "Gemini 4 Hydrogen (XHigh)", maxTokens: 1048576, maxOutputTokens: 65536, supportsImages: true, supportsThinking: true },
          "gemini-4-argon-disabled": { displayName: "Disabled Argon", isInternal: false },
          "internal-agent": { displayName: "Internal", isInternal: true },
          "tab_autocomplete": { displayName: "Tab" },
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    global.fetch = fetchMock;

    const res = await GET(new Request("https://example.com/api/providers/conn-ag-1/models"), {
      params: Promise.resolve({ id: "conn-ag-1" }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.refreshGoogleToken).toHaveBeenCalledTimes(1);
    expect(mocks.updateProviderCredentials).toHaveBeenCalledWith("conn-ag-1", {
      accessToken: "fresh-tok",
      refreshToken: "rt-1",
      expiresIn: 3600,
    });
    expect(fetchMock.mock.calls[1][0]).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels");
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({
      Authorization: "Bearer fresh-tok",
      "X-Client-Name": "antigravity",
      "X-Client-Version": "2.24.0",
    });
    expect(data.models).toEqual([
      {
        id: "gemini-4-hydrogen-xhigh",
        name: "Gemini 4 Hydrogen (XHigh)",
        contextLength: 1048576,
        maxOutputTokens: 65536,
        isVL: true,
        isReasoning: true,
      },
    ]);
  });

  it("dispatches pingModelByKind in-process on Cloudflare Workers without calling 127.0.0.1", async () => {
    globalThis.__D1_ADAPTER = { driver: "cloudflare-d1" };
    const fetchSpy = vi.fn(() => {
      throw new Error("Should not call loopback fetch on CF Worker");
    });
    global.fetch = fetchSpy;
    mocks.handleChat.mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "pong" } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const { pingModelByKind } = await import("../../src/app/api/models/test/ping.js");
    const out = await pingModelByKind("ag/gemini-4-hydrogen-high", "llm");

    expect(out.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.initTranslators).toHaveBeenCalledTimes(1);
    expect(mocks.handleChat).toHaveBeenCalledTimes(1);
    const forwardedReq = mocks.handleChat.mock.calls[0][0];
    expect(await forwardedReq.json()).toMatchObject({ model: "ag/gemini-4-hydrogen-high" });
  });
});
