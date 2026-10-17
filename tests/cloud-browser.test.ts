import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortalOperation } from "../src/portal.js";
import type { Thermostat } from "../src/types.js";

const mockBrowser = vi.hoisted(() => ({ acquire: vi.fn(), connect: vi.fn(), endpointURLString: vi.fn() }));
vi.mock("@cloudflare/playwright", () => mockBrowser);
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(readonly ctx: unknown, readonly env: unknown) {}
  },
}));

import { ThermostatSession } from "../cloud/browser.js";
import { encryptSession } from "../cloud/crypto.js";

const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

class MemoryStorage {
  values = new Map<string, unknown>();
  async get<T>(key: string) { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T) { this.values.set(key, value); }
  async delete(key: string) { return this.values.delete(key); }
  async deleteAll() { this.values.clear(); }
  async deleteAlarm() {}
  async setAlarm(_time: number) {}
}

async function tenant(name: string, connected = true) {
  const storage = new MemoryStorage();
  if (connected) await storage.put("saved", {
    state: await encryptSession(secret, { cookies: [], origins: [] }, name),
    verifiedAt: "2026-10-17T00:00:00.000Z",
  });
  const binding = { closeSession: vi.fn(), getSession: vi.fn(async () => null) };
  const instance = new ThermostatSession({ storage, id: { toString: () => name } } as never,
    { BROWSER: binding, SESSION_ENCRYPTION_KEY: secret } as never);
  return { instance, storage, binding };
}

function post(instance: ThermostatSession, path: string, body?: unknown) {
  return instance.fetch(new Request(`https://internal${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
  }));
}

describe("hosted thermostat tenant object", () => {
  let current: Thermostat;
  let operations: PortalOperation[];
  beforeEach(() => {
    vi.clearAllMocks();
    current = { id: "123456789012", name: "Home", temperatureF: 72, humidity: 40, mode: "auto", heatF: 68, coolF: 76,
      connected: true, heatMinF: 45, heatMaxF: 79, coolMinF: 65, coolMaxF: 92, minDeltaF: 5, equipment: "" };
    operations = [];
    mockBrowser.acquire.mockResolvedValue({ sessionId: "private-session" });
    const context = {
      newPage: async () => ({
        goto: async () => undefined,
        waitForFunction: async () => undefined,
        evaluate: async (_fn: unknown, operation: PortalOperation) => {
          operations.push(operation);
          if (operation.type === "list") return { ok: true, thermostats: [{ ...current }] };
          if (operation.type === "setTemperature") {
            current.heatF = operation.hold.heatF;
            current.coolF = operation.hold.coolF;
          }
          if (operation.type === "setMode") current.mode = operation.mode;
          return { ok: true };
        },
      }),
      storageState: async () => ({ cookies: [], origins: [] }),
    };
    mockBrowser.connect.mockResolvedValue({ newContext: async () => context, close: async () => undefined });
  });
  afterEach(() => vi.unstubAllGlobals());

  async function startAtHomepage(links: string[]) {
    const { instance, binding } = await tenant("tenant-a", false);
    const page = {
      goto: vi.fn(async () => undefined),
      url: () => "https://www.ecobee.com/en-us/",
      locator: () => ({ evaluateAll: async (read: (anchors: { getAttribute: (name: string) => string }[]) => unknown) =>
        read(links.map(href => ({ getAttribute: () => href }))) }),
    };
    mockBrowser.endpointURLString.mockReturnValue("http://fake.host/v1/devtools/browser/private-session?browser_binding=BROWSER");
    mockBrowser.connect.mockResolvedValue({
      contexts: () => [{ pages: () => [page], newCDPSession: async () => ({ send: async () => ({ targetInfo: { targetId: "tenant-page" } }) }) }],
      close: async () => undefined,
    });
    const getLiveView = vi.fn(async () => ({ devtoolsFrontendUrl: "https://live.browser.run/ui/view?jwt=private-access" }));
    Object.assign(binding, { getLiveView });
    return { result: await post(instance, "/start"), page, getLiveView };
  }

  const officialSignIn = "https://auth.ecobee.com/authorize?response_type=token&response_mode=form_post&client_id=discovered-public-client&redirect_uri=https%3A%2F%2Fwww.ecobee.com%2Fhome%2FauthCallback&audience=https%3A%2F%2Fprod.ecobee.com%2Fapi%2Fv1&scope=openid%20smartWrite%20piiWrite%20piiRead%20smartRead%20deleteGrants";

  it("opens the discovered official login on the existing Live View page without changing scopes", async () => {
    const { result, page, getLiveView } = await startAtHomepage([officialSignIn]);
    expect(result.status).toBe(200);
    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(page.goto.mock.calls[1][0]).toBe(officialSignIn);
    expect(getLiveView).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing official link", []],
    ["another authorization host", [officialSignIn.replace("auth.ecobee.com", "auth.ecobee.com.example.org")]],
    ["another callback", [officialSignIn.replace("www.ecobee.com%2Fhome%2FauthCallback", "example.org%2Fcallback")]],
    ["another audience", [officialSignIn.replace("prod.ecobee.com%2Fapi%2Fv1", "example.org%2Fapi")]],
    ["new unapproved permission", [`${officialSignIn}%20newPermission`]],
    ["duplicate callback", [`${officialSignIn}&redirect_uri=https%3A%2F%2Fexample.org%2Fcallback`]],
  ])("fails safely with %s", async (_description, links) => {
    const { result, page, getLiveView } = await startAtHomepage(links as string[]);
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ error: "site_changed" });
    expect(page.goto).toHaveBeenCalledOnce();
    expect(getLiveView).not.toHaveBeenCalled();
  });

  it("waits for the portal injector and hydrated token rather than Angular alone", async () => {
    const { instance } = await tenant("tenant-a");
    let injectorReady = false;
    let hasToken = false;
    const manager = { loadTokens: vi.fn(() => { hasToken = true; }), haveToken: () => hasToken };
    const element = {};
    vi.stubGlobal("location", { protocol: "https:", hostname: "www.ecobee.com", pathname: "/consumerportal/index.html" });
    vi.stubGlobal("document", { querySelector: () => element, body: element, documentElement: element });
    vi.stubGlobal("window", { angular: { element: () => ({ injector: () => {
      if (!injectorReady) return undefined;
      return { get: () => manager };
    } }) } });
    const evaluate = vi.fn(async () => ({ ok: true, thermostats: [current] }));
    const waitForFunction = vi.fn(async (ready: () => boolean, _arg: unknown, options: { timeout: number }) => {
      expect(options.timeout).toBe(15_000);
      expect(ready()).toBe(false);
      expect(evaluate).not.toHaveBeenCalled();
      injectorReady = true;
      expect(ready()).toBe(true);
    });
    mockBrowser.connect.mockResolvedValue({
      newContext: async () => ({
        newPage: async () => ({ goto: async () => undefined, waitForFunction, evaluate }),
        storageState: async () => ({ cookies: [], origins: [] }),
      }),
      close: async () => undefined,
    });
    const result = await post(instance, "/control", { method: "list", args: {}, tokenAllowsWrites: false });
    expect(result.status).toBe(200);
    expect(manager.loadTokens).toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it.each([
    ["https://www.ecobee.com/consumerportal/index.html", "site_changed", true],
    ["https://auth.ecobee.com/u/login/identifier", "login_required", false],
  ] as const)("classifies readiness timeout at %s without misidentifying slow bootstrap", async (url, errorCode, keepSaved) => {
    const { instance, storage } = await tenant("tenant-a");
    const timeout = new Error("Portal wait timed out");
    timeout.name = "TimeoutError";
    const evaluate = vi.fn();
    mockBrowser.connect.mockResolvedValue({
      newContext: async () => ({ newPage: async () => ({
        goto: async () => undefined,
        url: () => url,
        waitForFunction: async () => { throw timeout; },
        evaluate,
      }) }),
      close: async () => undefined,
    });
    const result = await post(instance, "/control", { method: "list", args: {}, tokenAllowsWrites: false });
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ error: errorCode });
    expect(storage.values.has("saved")).toBe(keepSaved);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("requires both account permission and the MCP token's write permission", async () => {
    const { instance } = await tenant("tenant-a");
    let result = await post(instance, "/control", { method: "setMode", args: { thermostat_id: current.id, mode: "cool" }, tokenAllowsWrites: true });
    expect(result.status).toBe(400);
    await post(instance, "/preferences", { allowWrites: true });
    result = await post(instance, "/control", { method: "setMode", args: { thermostat_id: current.id, mode: "cool" }, tokenAllowsWrites: false });
    expect(result.status).toBe(400);
    expect(operations.every(operation => operation.type === "list")).toBe(true);
  });

  it("serializes the full read-change-read cycle so simultaneous partial changes are preserved", async () => {
    const { instance } = await tenant("tenant-a");
    await post(instance, "/preferences", { allowWrites: true });
    const [heat, cool] = await Promise.all([
      post(instance, "/control", { method: "setTemperature", args: { thermostat_id: current.id, heat: 69, unit: "F", hours: 2 }, tokenAllowsWrites: true }),
      post(instance, "/control", { method: "setTemperature", args: { thermostat_id: current.id, cool: 78, unit: "F", hours: 2 }, tokenAllowsWrites: true }),
    ]);
    expect(heat.status).toBe(200);
    expect(cool.status).toBe(200);
    expect(current.heatF).toBe(69);
    expect(current.coolF).toBe(78);
    const changes = operations.filter(operation => operation.type === "setTemperature");
    expect(changes[1]).toMatchObject({ hold: { heatF: 69, coolF: 78 } });
  });

  it("rejects another tenant's encrypted login before allocating a browser", async () => {
    const first = await tenant("tenant-a");
    const second = await tenant("tenant-b", false);
    second.storage.values.set("saved", first.storage.values.get("saved"));
    const result = await post(second.instance, "/control", { method: "list", args: {}, tokenAllowsWrites: false });
    expect(result.status).toBe(503);
    expect(mockBrowser.acquire).not.toHaveBeenCalled();
  });

  it("reports an uncertain write if the browser disconnects during its response", async () => {
    const { instance } = await tenant("tenant-a");
    await post(instance, "/preferences", { allowWrites: true });
    const evaluate = vi.fn(async (_fn: unknown, operation: PortalOperation) => {
      if (operation.type === "list") return { ok: true, thermostats: [current] };
      throw new Error("Private browser URL must not appear in the response");
    });
    mockBrowser.connect.mockResolvedValue({
      newContext: async () => ({ newPage: async () => ({ goto: async () => undefined, waitForFunction: async () => undefined, evaluate }) }),
      close: async () => undefined,
    });
    const result = await post(instance, "/control", { method: "setMode", args: { thermostat_id: current.id, mode: "cool" }, tokenAllowsWrites: true });
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ error: "write_uncertain" });
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it("removes the login and account write permission on disconnect", async () => {
    const { instance } = await tenant("tenant-a");
    await post(instance, "/preferences", { allowWrites: true });
    expect((await post(instance, "/disconnect")).status).toBe(200);
    const status = await instance.fetch(new Request("https://internal/status"));
    expect(await status.json()).toMatchObject({ connected: false, allowWrites: false });
    const result = await post(instance, "/control", { method: "list", args: {}, tokenAllowsWrites: false });
    expect(result.status).toBe(409);
  });

  it("keeps sign-in private until verified, then closes the Live View browser", async () => {
    const { instance, storage, binding } = await tenant("tenant-a", false);
    const privateUrl = "https://live.browser.run/ui/view?jwt=private-access";
    const page = {
      goto: vi.fn(async () => undefined),
      url: () => "https://www.ecobee.com/consumerportal/index.html",
      waitForFunction: vi.fn(async () => undefined),
      evaluate: vi.fn(async () => ({ ok: true, thermostats: [current] })),
    };
    const context = {
      pages: () => [page],
      newCDPSession: async () => ({ send: async () => ({ targetInfo: { targetId: "tenant-page" } }) }),
      storageState: async () => ({ cookies: [{ name: "session", value: "private-cookie" }], origins: [] }),
    };
    mockBrowser.endpointURLString.mockReturnValue("http://fake.host/v1/devtools/browser/private-session?browser_binding=BROWSER");
    mockBrowser.connect.mockResolvedValue({ contexts: () => [context], close: vi.fn(async () => undefined) });
    binding.getSession.mockResolvedValue({ sessionId: "private-session" } as never);
    Object.assign(binding, { getLiveView: vi.fn(async () => ({ devtoolsFrontendUrl: privateUrl })) });

    const start = await post(instance, "/start");
    expect(start.status).toBe(200);
    expect(await start.json()).toMatchObject({ liveViewUrl: privateUrl });
    expect(String(mockBrowser.connect.mock.calls[0][0])).toContain("persistent=true");
    expect(storage.values.has("saved")).toBe(false);
    expect(JSON.stringify([...storage.values.values()])).not.toContain("jwt=private-access");

    const finish = await post(instance, "/finish");
    expect(finish.status).toBe(200);
    expect(binding.closeSession).toHaveBeenCalledWith("private-session");
    expect(storage.values.has("login")).toBe(false);
    expect(storage.values.has("saved")).toBe(true);
    expect(JSON.stringify([...storage.values.values()])).not.toContain("private-cookie");
  });

  it("retains the browser reference when closure fails so cleanup can be retried", async () => {
    const { instance, storage, binding } = await tenant("tenant-a");
    await storage.put("login", { sessionId: "private-session", expiresAt: Date.now() + 60_000 });
    binding.getSession.mockResolvedValue({ sessionId: "private-session" } as never);
    binding.closeSession.mockRejectedValue(new Error("Cloudflare unavailable"));
    const result = await post(instance, "/disconnect");
    expect(result.status).toBe(503);
    expect(storage.values.has("login")).toBe(true);
  });
});
