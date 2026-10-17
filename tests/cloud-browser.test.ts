import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortalOperation } from "../src/portal.js";
import type { FeatureRequest } from "../src/feature-types.js";
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
  let features: FeatureRequest[];
  beforeEach(() => {
    vi.clearAllMocks();
    current = { id: "123456789012", name: "Home", temperatureF: 72, humidity: 40, mode: "auto", heatF: 68, coolF: 76,
      connected: true, heatMinF: 45, heatMaxF: 79, coolMinF: 65, coolMaxF: 92, minDeltaF: 5, equipment: "" };
    operations = [];
    features = [];
    mockBrowser.acquire.mockResolvedValue({ sessionId: "private-session" });
    const context = {
      newPage: async () => ({
        goto: async () => undefined,
        waitForFunction: async () => undefined,
        evaluate: async (_fn: unknown, operation?: PortalOperation | FeatureRequest) => {
          if (!operation) return false;
          if ("name" in operation) {
            features.push(operation);
            return { ok: true, data: { delivery: "accepted", verification: "observed" } };
          }
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

  const jwt = (exp: unknown) => `e30.${btoa(JSON.stringify({ exp, private: "PRIVATE" })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}.signature`;

  it.each([
    ["expired Redux", -60, 60, true],
    ["fresh Redux overrides old cookie", 60, -60, false],
    ["cookie fallback", undefined, -60, true],
    ["unknown expiry", undefined, undefined, false],
  ] as const)("returns only an expiry boolean for %s", async (_label, reduxAge, cookieAge, expected) => {
    const { instance } = await tenant("tenant-a");
    const now = Math.floor(Date.now() / 1000);
    vi.stubGlobal("window", { ecobeeStore: { getState: () => ({ tokens: { token: reduxAge === undefined ? "opaque" : jwt(now + reduxAge) } }) } });
    vi.stubGlobal("document", { cookie: cookieAge === undefined ? "" : `_TOKEN=${jwt(now + cookieAge)}` });
    const probe = instance as unknown as { expiredPortalToken(page: unknown): Promise<boolean> };
    const result = await probe.expiredPortalToken({ evaluate: async (fn: () => boolean) => fn() });
    expect(result).toBe(expected);
    expect(typeof result).toBe("boolean");
  });

  it.each([true, false])("renews an expired session once before any write (SSO succeeds: %s)", async success => {
    const { instance, storage } = await tenant("tenant-a");
    await post(instance, "/preferences", { allowWrites: true });
    const now = Math.floor(Date.now() / 1000);
    let token = jwt(now - 60);
    let url = "https://www.ecobee.com/consumerportal/index.html";
    const events: string[] = [];
    vi.stubGlobal("window", { ecobeeStore: { getState: () => ({ tokens: { token } }) } });
    vi.stubGlobal("document", { get cookie() { return `_TOKEN=${token}`; } });
    const page = {
      url: () => url,
      goto: vi.fn(async (destination: string) => {
        url = destination;
        if (destination === officialSignIn) {
          events.push("renew");
          if (success) token = jwt(now + 3600);
          url = "https://www.ecobee.com/consumerportal/index.html";
        }
      }),
      locator: () => ({ evaluateAll: async (read: (anchors: { getAttribute: () => string }[]) => unknown) => read([{ getAttribute: () => officialSignIn }]) }),
      waitForFunction: async () => undefined,
      evaluate: async (fn: () => boolean, operation?: PortalOperation) => {
        if (!operation) return fn();
        events.push(operation.type);
        if (operation.type === "list") return { ok: true, thermostats: [{ ...current }] };
        expect(events.indexOf("save")).toBeLessThan(events.indexOf(operation.type));
        if (operation.type === "setMode") current.mode = operation.mode;
        return { ok: true };
      },
    };
    const newContext = vi.fn(async () => ({
      newPage: async () => page,
      storageState: async () => { events.push("save"); return { cookies: [{ name: "_TOKEN", value: token }], origins: [] }; },
    }));
    mockBrowser.connect.mockResolvedValue({ newContext, close: async () => undefined });
    const result = await post(instance, "/control", { method: "setMode", args: { thermostat_id: current.id, mode: "cool" }, tokenAllowsWrites: true });
    expect(result.status).toBe(success ? 200 : 409);
    expect(events.filter(value => value === "renew")).toHaveLength(1);
    expect(events.filter(value => value === "setMode")).toHaveLength(success ? 1 : 0);
    expect(newContext).toHaveBeenCalledOnce();
    expect(storage.values.has("saved")).toBe(success);
  });

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
    const evaluate = vi.fn(async (_fn: unknown, operation?: PortalOperation) => operation ? ({ ok: true, thermostats: [current] }) : false);
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
    expect(evaluate).toHaveBeenCalledTimes(2);
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

  it.each([[false, true], [true, false], [true, true]] as const)("enforces both permissions for expanded controls (account %s, token %s)", async (accountWrites, tokenWrites) => {
    const { instance } = await tenant("tenant-a");
    await post(instance, "/preferences", { allowWrites: accountWrites });
    const args = { name: "set_eco_plus", input: { thermostat_id: current.id, enabled: false } };
    const result = await post(instance, "/control", { method: "feature", args, tokenAllowsWrites: tokenWrites });
    expect(result.status).toBe(accountWrites && tokenWrites ? 200 : 400);
    expect(features).toEqual(accountWrites && tokenWrites ? [args] : []);
  });

  it("allows expanded reads without write permission and rejects unowned targets", async () => {
    const { instance } = await tenant("tenant-a");
    const result = await post(instance, "/control", { method: "feature", args: { name: "get_energy_status", input: { thermostat_id: current.id } }, tokenAllowsWrites: false });
    expect(result.status).toBe(200);
    expect(features.map(feature => feature.name)).toEqual(["get_energy_status"]);
    const missing = await post(instance, "/control", { method: "feature", args: { name: "get_energy_status", input: { thermostat_id: "999999999999" } }, tokenAllowsWrites: false });
    expect(missing.status).toBe(400);
    expect(features).toHaveLength(1);
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
    const evaluate = vi.fn(async (_fn: unknown, operation?: PortalOperation) => {
      if (!operation) return false;
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
    expect(evaluate).toHaveBeenCalledTimes(3);
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
