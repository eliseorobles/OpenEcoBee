import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sign, verify, type Identity } from "../cloud/auth.js";

vi.mock("../cloud/browser.js", () => ({ ThermostatSession: class {} }));

// The provider's runtime imports cloudflare:workers, which Node cannot load.
// This explicit boundary tests our handlers, not OAuth token verification.
// MCP adapter tests inject the context normally supplied by that provider.
const authBoundary = vi.hoisted(() => ({
  context: null as null | { props: { userId: string; login: string }; auth: { scope: string[] } },
}));
vi.mock("@cloudflare/workers-oauth-provider", () => ({
  AuthorizationError: class extends Error {},
  default: class {
    constructor(private handlers: {
      apiHandler: { fetch: (...args: unknown[]) => Promise<Response> };
      defaultHandler: { fetch: (...args: unknown[]) => Promise<Response> };
    }) {}
    async fetch(request: Request, env: unknown, ctx: object) {
      if (new URL(request.url).pathname === "/mcp") {
        if (!authBoundary.context) return new Response("Unauthorized.", { status: 401 });
        return this.handlers.apiHandler.fetch(request, env, { ...ctx, ...authBoundary.context });
      }
      return this.handlers.defaultHandler.fetch(request, env, ctx);
    }
  },
}));

import worker, { type Env } from "../cloud/index.js";

const origin = "https://thermostat.example";
const cookieSecret = "hosted-worker-test-secret-longer-than-32-chars";
const user: Identity = { userId: "54321", login: "home-owner", csrf: "test-csrf-token", exp: Date.now() + 86_400_000 };

function setup(overrides: Partial<Env> = {}) {
  const requests: Request[] = [];
  const tenantFetch = vi.fn(async (request: Request) => {
    requests.push(request.clone());
    if (new URL(request.url).pathname === "/status") return Response.json({ connected: true, allowWrites: false });
    if (new URL(request.url).pathname === "/start") return Response.json({ liveViewUrl: "https://browser.example/private-view" });
    return Response.json({ ok: true, data: { adapterResponse: true } });
  });
  const idFromName = vi.fn((name: string) => name);
  const get = vi.fn(() => ({ fetch: tenantFetch }));
  const env = {
    PUBLIC_ORIGIN: origin,
    COOKIE_SECRET: cookieSecret,
    ALLOWED_GITHUB_USERS: "home-owner",
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-client-secret",
    OAUTH_KV: { get: vi.fn(async () => null), put: vi.fn() },
    THERMOSTAT_SESSIONS: { idFromName, get },
    ...overrides,
  } as unknown as Env;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as ExecutionContext;
  return { env, ctx, idFromName, get, tenantFetch, requests, pending };
}

async function sessionCookie(identity: Identity = user) {
  return `__Host-openecobee=${await sign(identity, cookieSecret)}`;
}

async function appRequest(path: string, options: { csrf?: string; origin?: string; session?: Identity; fields?: Record<string, string>; method?: string } = {}) {
  const headers = new Headers({ Cookie: await sessionCookie(options.session) });
  if (options.origin !== "missing") headers.set("Origin", options.origin ?? origin);
  const form = new URLSearchParams({ csrf: options.csrf ?? user.csrf, ...options.fields });
  return new Request(`${origin}${path}`, { method: options.method ?? "POST", headers, body: options.method === "GET" ? undefined : form });
}

beforeEach(() => { authBoundary.context = null; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("hosted app request security", () => {
  it("rejects HTTP, an origin mismatch, and a malformed deployment origin", async () => {
    for (const [requestUrl, configuredOrigin] of [
      ["http://thermostat.example/health", "http://thermostat.example"],
      ["https://another.example/health", origin],
      [`${origin}/health`, `${origin}/path`],
    ]) {
      const { env, ctx, tenantFetch } = setup({ PUBLIC_ORIGIN: configuredOrigin });
      expect((await worker.fetch(new Request(requestUrl), env, ctx)).status).toBe(503);
      expect(tenantFetch).not.toHaveBeenCalled();
    }
  });

  it("requires a signed allowed session before selecting a tenant", async () => {
    const { env, ctx, idFromName } = setup();
    const response = await worker.fetch(new Request(`${origin}/app`, { headers: { Cookie: "__Host-openecobee=forged.session" } }), env, ctx);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/login");
    expect(idFromName).not.toHaveBeenCalled();
  });

  it.each(["", "someone-else"])("fails closed for account allowlist %s", async allowed => {
    const { env, ctx, idFromName } = setup({ ALLOWED_GITHUB_USERS: allowed });
    const response = await worker.fetch(new Request(`${origin}/app`, { headers: { Cookie: await sessionCookie() } }), env, ctx);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/login");
    expect(idFromName).not.toHaveBeenCalled();
  });

  it("selects the tenant only from the signed numeric identity, ignoring URL input", async () => {
    const { env, ctx, idFromName, requests } = setup();
    const response = await worker.fetch(new Request(`${origin}/app?userId=99999&tenant=other-user`, { headers: { Cookie: await sessionCookie() } }), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("home-owner");
    expect(idFromName).toHaveBeenCalledExactlyOnceWith("github:54321");
    expect(new URL(requests[0].url).pathname).toBe("/status");
  });

  it("rejects an expired session and a signed nonnumeric tenant identity", async () => {
    for (const session of [{ ...user, exp: Date.now() - 1 }, { ...user, userId: "../another-tenant" }]) {
      const { env, ctx, idFromName } = setup();
      const response = await worker.fetch(new Request(`${origin}/app`, { headers: { Cookie: await sessionCookie(session) } }), env, ctx);
      expect(response.status).toBe(303);
      expect(idFromName).not.toHaveBeenCalled();
    }
  });

  it.each([
    { origin: "https://attacker.example" },
    { origin: "missing" },
    { csrf: "attacker-csrf" },
  ])("rejects app writes without matching origin and CSRF %j", async options => {
    const { env, ctx, tenantFetch } = setup();
    const response = await worker.fetch(await appRequest("/app/preferences", { ...options, fields: { allowWrites: "yes" } }), env, ctx);
    expect(response.status).toBe(403);
    expect(tenantFetch).not.toHaveBeenCalled();
  });

  it.each(["/app/start", "/app/finish", "/app/preferences", "/app/disconnect"])("requires POST for app action %s", async path => {
    const { env, ctx, tenantFetch } = setup();
    const response = await worker.fetch(await appRequest(path, { method: "GET" }), env, ctx);
    expect(response.status).toBe(405);
    expect(tenantFetch).not.toHaveBeenCalled();
  });

  it("changes only the signed tenant's account preference after CSRF verification", async () => {
    const { env, ctx, idFromName, requests } = setup();
    const response = await worker.fetch(await appRequest("/app/preferences?userId=99999", { fields: { allowWrites: "yes", userId: "99999" } }), env, ctx);
    expect(response.status).toBe(303);
    expect(idFromName).toHaveBeenCalledExactlyOnceWith("github:54321");
    expect(new URL(requests[0].url).pathname).toBe("/preferences");
    expect(await requests[0].json()).toEqual({ allowWrites: true });
  });

  it("clears the app session on a verified logout without contacting the thermostat", async () => {
    const { env, ctx, tenantFetch } = setup();
    const response = await worker.fetch(await appRequest("/app/logout"), env, ctx);
    expect(response.status).toBe(303);
    expect(response.headers.get("Set-Cookie")).toContain("__Host-openecobee=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0");
    expect(tenantFetch).not.toHaveBeenCalled();
  });
});

describe("hosted GitHub callback", () => {
  it("requires the same signed login flow in the state and browser cookie", async () => {
    const { env, ctx, idFromName } = setup();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const flow = await sign({ exp: Date.now() + 60_000, verifier: "test-verifier" }, cookieSecret);
    const response = await worker.fetch(new Request(`${origin}/callback?state=app.${flow}&code=code`, { headers: { Cookie: "__Host-openecobee-login=another-flow" } }), env, ctx);
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(idFromName).not.toHaveBeenCalled();
  });

  it("issues a session for the verified GitHub numeric id and ignores a URL user id", async () => {
    const { env, ctx } = setup();
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ access_token: "private-token" })).mockResolvedValueOnce(Response.json({ id: 54321, login: "home-owner" }));
    vi.stubGlobal("fetch", fetch);
    const flow = await sign({ exp: Date.now() + 60_000, verifier: "test-verifier" }, cookieSecret);
    const response = await worker.fetch(new Request(`${origin}/callback?state=app.${flow}&code=code&userId=99999`, { headers: { Cookie: `__Host-openecobee-login=${flow}` } }), env, ctx);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/app");
    const value = response.headers.getSetCookie().find(cookie => cookie.startsWith("__Host-openecobee="))!.split(";")[0].slice("__Host-openecobee=".length);
    const session = await verify<Identity>(value, cookieSecret);
    expect(session).toMatchObject({ userId: "54321", login: "home-owner" });
    expect(session?.csrf).toMatch(/^[a-zA-Z0-9_-]{43}$/);
    expect(response.headers.get("Set-Cookie")).not.toContain("private-token");
  });
});

describe("hosted MCP tenant adapter", () => {
  async function callTool(name: string, args: Record<string, unknown>, options: { scopes?: string[]; userId?: string; login?: string } = {}) {
    authBoundary.context = { props: { userId: options.userId ?? user.userId, login: options.login ?? user.login }, auth: { scope: options.scopes ?? ["thermostat:read", "thermostat:write"] } };
    const state = setup();
    const request = new Request(`${origin}/mcp?userId=99999`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const response = await worker.fetch(request, state.env, state.ctx);
    await Promise.all(state.pending);
    return { ...state, response };
  }

  it.each([
    ["list_thermostats", {}, "list", {}],
    ["get_thermostat_status", { thermostat_id: "123456789012" }, "status", { thermostat_id: "123456789012" }],
    ["set_temperature", { thermostat_id: "123456789012", heat: 20, unit: "C", hours: 2 }, "setTemperature", { thermostat_id: "123456789012", heat: 20, unit: "C", hours: 2 }],
    ["set_hvac_mode", { thermostat_id: "123456789012", mode: "cool" }, "setMode", { thermostat_id: "123456789012", mode: "cool" }],
    ["resume_schedule", { thermostat_id: "123456789012" }, "resume", { thermostat_id: "123456789012" }],
  ] as const)("maps %s to the tenant /control argument shape", async (name, args, method, expectedArgs) => {
    const { response, idFromName, requests } = await callTool(name, args);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { structuredContent: { adapterResponse: true } } });
    expect(idFromName).toHaveBeenCalledExactlyOnceWith("github:54321");
    expect(new URL(requests[0].url).pathname).toBe("/control");
    expect(await requests[0].json()).toEqual({ method, args: expectedArgs, tokenAllowsWrites: true });
  });

  it("forwards a read-only token as lacking write permission", async () => {
    const { response, requests } = await callTool("set_hvac_mode", { thermostat_id: "123456789012", mode: "cool" }, { scopes: ["thermostat:read"] });
    expect(response.status).toBe(200);
    expect(await requests[0].json()).toMatchObject({ tokenAllowsWrites: false });
  });

  it.each([
    { scopes: ["thermostat:write"] },
    { userId: "other-tenant" },
    { login: "uninvited-user" },
  ])("rejects invalid verified authorization context %j before selecting a tenant", async options => {
    const { response, idFromName } = await callTool("list_thermostats", {}, options);
    expect(response.status).toBe(403);
    expect(idFromName).not.toHaveBeenCalled();
  });

  it("rejects unknown tool arguments before calling the tenant", async () => {
    const { response, tenantFetch } = await callTool("list_thermostats", { userId: "99999" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { isError: true } });
    expect(tenantFetch).not.toHaveBeenCalled();
  });
});
