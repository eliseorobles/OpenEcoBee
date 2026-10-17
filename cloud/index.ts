import OAuthProvider, { AuthorizationError, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer, type ThermostatControls } from "../src/tools.js";
import { UserError, type Thermostat } from "../src/types.js";
import { ThermostatSession, type BrowserEnv } from "./browser.js";
import { allowedLogin, cookie, cookieValue, escapeHtml, githubIdentity, githubUrl, nonce, page, sign, verify, type Identity } from "./auth.js";
export { ThermostatSession };

export interface Env extends BrowserEnv {
  THERMOSTAT_SESSIONS: DurableObjectNamespace<ThermostatSession>;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_SECRET: string;
  PUBLIC_ORIGIN: string;
  ALLOWED_GITHUB_USERS: string;
}
const SESSION_COOKIE = "__Host-openecobee";
const FLOW_COOKIE = "__Host-openecobee-login";
const scopes = ["thermostat:read", "thermostat:write", "offline_access"];

async function identity(request: Request, env: Env): Promise<Identity | null> {
  const session = await verify<Identity>(cookieValue(request, SESSION_COOKIE), env.COOKIE_SECRET);
  return session && /^\d+$/.test(session.userId) && allowedLogin(session.login, env.ALLOWED_GITHUB_USERS) ? session : null;
}
function tenant(env: Env, userId: string) { return env.THERMOSTAT_SESSIONS.get(env.THERMOSTAT_SESSIONS.idFromName(`github:${userId}`)); }
async function internal(env: Env, userId: string, path: string, body?: unknown) {
  return tenant(env, userId).fetch(new Request(`https://tenant.internal${path}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
}
function redirect(location: string, headers?: HeadersInit) { const h = new Headers(headers); h.set("Location", location); h.set("Cache-Control", "no-store"); return new Response(null, { status: 303, headers: h }); }
function csrfValid(request: Request, session: Identity, form: FormData, env: Env) { return request.headers.get("Origin") === env.PUBLIC_ORIGIN && form.get("csrf") === session.csrf; }
function hidden(session: Identity) { return `<input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">`; }

function energyReport(value: unknown): string {
  const object = (input: unknown): Record<string, unknown> => input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const data = object(value);
  const energy = object(data.energy);
  const program = object(data.program);
  const state = data.energyFeatureState;
  const running = Array.isArray(data.runningEvents) ? data.runningEvents.map(object) : [];
  const climate = Array.isArray(program.climates) ? program.climates.map(object).find(item => item.climateRef === program.currentClimateRef) : undefined;
  const display = (item: unknown) => typeof item === "number" && Number.isFinite(item) ? `${item} °F` : "Not reported";
  const hold = running.find(item => item.type === "hold");
  const holdText = !hold ? "No running manual hold reported" : hold.isIndefinite === true ? "Until changed" : "A hold is active; its duration is shown in the ecobee app";
  return `<section><h2>${escapeHtml(typeof data.name === "string" ? data.name : "Ecobee")}</h2><p>Displayed temperature: <strong>${display(data.displayedTemperatureF)}</strong><br>Unadjusted thermostat temperature: ${display(data.dryBulbTemperatureF)}<br>Eco+ master state: <strong>${state === "enabled" ? "On" : state === "disabled" ? "Off" : "Not reported"}</strong><br>Humidity adjustment: ${energy.feelsLikeMode === "humidex" ? "Humidity-adjusted temperature is reported" : "Not established by the reported data"}<br>Manual hold: ${escapeHtml(holdText)}<br>Scheduled comfort setting: ${escapeHtml(typeof climate?.name === "string" ? climate.name : "Not reported")}</p><p>Running events: ${escapeHtml(running.map(item => typeof item.type === "string" ? item.type : "unknown").join(", ") || "None reported")}</p></section>`;
}

async function appPage(env: Env, session: Identity) {
  const response = await internal(env, session.userId, "/status");
  const state = await response.json() as { connected: boolean; allowWrites: boolean };
  return page("Your ecobee connection", `<p>Signed in as <strong>${escapeHtml(session.login)}</strong>. Ecobee: <strong>${state.connected ? "connected" : "not connected"}</strong>.</p><p>Open the private hosted browser and sign in to ecobee, including MFA. Your login happens inside a Cloudflare browser. This service stores an encrypted browser session and can use it to access your thermostat.</p><p>The standard ecobee portal session also permits access to your profile and sign-in management. OpenEcoBee uses the session for thermostat controls.</p><form method="post" action="/app/start">${hidden(session)}<button>Open ecobee sign-in</button></form><form method="post" action="/app/finish">${hidden(session)}<button>Finish connecting ecobee</button></form><form method="post" action="/app/check">${hidden(session)}<button>Check connection</button></form><form method="post" action="/app/energy">${hidden(session)}<button>Check energy and automation</button></form><form method="post" action="/app/preferences">${hidden(session)}<label><input type="checkbox" name="allowWrites" value="yes" ${state.allowWrites ? "checked" : ""}> Allow thermostat changes from authorized MCP clients</label><p>Includes temperature and fan holds, HVAC mode, schedules, comfort settings, eco+ master control, vacations, alerts, sensors, groups, audio, timezone, and supported thermostat settings. Advanced HVAC changes and preference resets require an explicit request.</p><button>Save permissions</button></form><p>MCP URL: <code>${escapeHtml(env.PUBLIC_ORIGIN)}/mcp</code>. Add it to ChatGPT as a custom MCP server with OAuth.</p><form method="post" action="/app/disconnect">${hidden(session)}<button>Disconnect ecobee and delete saved session</button></form><form method="post" action="/app/logout">${hidden(session)}<button>Sign out of OpenEcoBee</button></form><p class="muted">Browser compatibility and real thermostat control are still under verification. If ecobee blocks hosted sign-in, the service cannot connect.</p>`);
}

async function defaultFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/") return page("Your thermostat, through ChatGPT", `<p>An open source MCP for ecobee using normal browser sign-in. No ecobee developer API key or local companion is required by this hosted design.</p><p>This is an experimental deployment. Each account gets an isolated hosted browser session; this service can access the sessions it stores.</p><p><a class="button" href="/login">Continue with GitHub</a></p><p>GitHub identifies your OpenEcoBee account. You connect ecobee separately.</p>`);
  if (path === "/health") return Response.json({ ok: true, experimental: true }, { headers: { "Cache-Control": "no-store" } });
  if (path === "/login" && request.method === "GET") {
    const verifier = nonce();
    const flow = await sign({ exp: Date.now() + 600000, verifier, nonce: nonce() }, env.COOKIE_SECRET);
    return redirect(await githubUrl(`app.${flow}`, verifier, env), { "Set-Cookie": cookie(FLOW_COOKIE, flow, 600) });
  }
  if (path === "/authorize" && request.method === "GET") {
    const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    const details = await env.OAUTH_PROVIDER.describeConsent(authRequest);
    const consent = await env.OAUTH_PROVIDER.beginConsent(authRequest);
    return page("Authorize thermostat access", `<p>Allow <strong>${escapeHtml(details.clientName)}</strong> to access your thermostat?</p><p>${details.clientDomain ? `Published by ${escapeHtml(details.clientDomain)}.` : "The client supplied its own name; it is not verified."} Access returns to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>${details.redirectIsLoopback ? "<p>This returns access to an app on your computer. Continue only if you started this connection.</p>" : ""}<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escapeHtml(consent.handle)}"><input type="hidden" name="scope" value="thermostat:read"><label><input type="checkbox" checked disabled> Read thermostat status (required)</label><label><input type="checkbox" name="scope" value="thermostat:write" ${details.scope.includes("thermostat:write") ? "checked" : ""}> Allow thermostat changes (optional)</label><label><input type="checkbox" name="scope" value="offline_access" checked> Keep this client connected (optional)</label><p>Read access includes thermostat status, energy and automation, schedules, sensors, alerts, and supported reports. Write access allows the supported thermostat controls, including comfort settings, schedules, eco+ master control, vacations, fan, alerts, groups, audio, timezone, and advanced settings or preference resets when explicitly requested and enabled in your connection settings.</p><button name="decision" value="approve">Allow and continue with GitHub</button> <button name="decision" value="deny">Deny</button></form>`, consent.headers);
  }
  if (path === "/authorize" && request.method === "POST") {
    if (request.headers.get("Origin") !== env.PUBLIC_ORIGIN) return new Response("Invalid origin.", { status: 403 });
    const form = await request.formData();
    if (form.get("decision") !== "approve") { const denied = await env.OAUTH_PROVIDER.denyConsent(request, String(form.get("handle"))); return new Response(null, { status: 302, headers: denied.headers }); }
    const approved = await env.OAUTH_PROVIDER.approveConsent(request, String(form.get("handle")), { scope: form.getAll("scope").map(String) });
    if (!approved.request.scope.includes("thermostat:read")) return page("Read permission required", "<p>Restart the connection and grant thermostat:read.</p>");
    const verifier = nonce();
    const upstream = await env.OAUTH_PROVIDER.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
    upstream.headers.set("Location", await githubUrl(upstream.state, verifier, env));
    return new Response(null, { status: 302, headers: upstream.headers });
  }
  if (path === "/callback" && request.method === "GET") {
    const state = url.searchParams.get("state") ?? "";
    let verifier: string;
    let upstream: Awaited<ReturnType<OAuthHelpers["finishUpstream"]>> | undefined;
    if (state.startsWith("app.")) {
      const signed = state.slice(4);
      if (cookieValue(request, FLOW_COOKIE) !== signed) return new Response("Sign-in state mismatch.", { status: 400 });
      const flow = await verify<{ exp: number; verifier: string }>(signed, env.COOKIE_SECRET);
      if (!flow) return new Response("Sign-in expired.", { status: 400 });
      verifier = flow.verifier;
    } else {
      upstream = await env.OAUTH_PROVIDER.finishUpstream<{ verifier: string }>(request);
      verifier = (upstream.data as { verifier: string }).verifier;
    }
    const code = url.searchParams.get("code");
    if (!code || code.length > 512) return page("Sign-in cancelled", "<p>Return to your client or <a href='/'>start again</a>.</p>");
    const user = await githubIdentity(code, verifier, env);
    if (!allowedLogin(user.login, env.ALLOWED_GITHUB_USERS)) return new Response("This deployment is limited to invited GitHub users.", { status: 403 });
    const session: Identity = { ...user, csrf: nonce(), exp: Date.now() + 14 * 86400000 };
    const headers = upstream?.headers ?? new Headers();
    headers.append("Set-Cookie", cookie(SESSION_COOKIE, await sign(session, env.COOKIE_SECRET), 14 * 86400));
    headers.append("Set-Cookie", cookie(FLOW_COOKIE, "", 0));
    if (upstream) {
      const result = await env.OAUTH_PROVIDER.completeAuthorization({ request: upstream.request, userId: user.userId, metadata: { label: user.login }, scope: upstream.request.scope, props: { userId: user.userId, login: user.login } });
      return redirect(result.redirectTo, headers);
    }
    return redirect("/app", headers);
  }
  if (path === "/app" || path.startsWith("/app/")) {
    const session = await identity(request, env);
    if (!session) return redirect("/login");
    if (path === "/app" && request.method === "GET") return appPage(env, session);
    if (request.method !== "POST") return new Response("Method not allowed.", { status: 405 });
    const form = await request.formData();
    if (!csrfValid(request, session, form, env)) return new Response("Invalid form session.", { status: 403 });
    if (path === "/app/logout") return redirect("/", { "Set-Cookie": cookie(SESSION_COOKIE, "", 0) });
    if (path === "/app/energy") {
      const listed = await internal(env, session.userId, "/control", { method: "list", args: {}, tokenAllowsWrites: false });
      const payload = await listed.json() as { ok?: boolean; data?: { thermostats?: Array<{ id: string }> } };
      if (!listed.ok || !payload.ok || !Array.isArray(payload.data?.thermostats)) return page("Connection needs attention", "<p>Reconnect ecobee to read its energy and automation settings.</p><a href='/app'>Return to connection</a>");
      const reports: string[] = [];
      for (const thermostat of payload.data.thermostats.slice(0, 10)) {
        const response = await internal(env, session.userId, "/control", { method: "feature", args: { name: "get_energy_status", input: { thermostat_id: thermostat.id } }, tokenAllowsWrites: false });
        const result = await response.json() as { ok?: boolean; data?: { data?: unknown } };
        reports.push(response.ok && result.ok ? energyReport(result.data?.data) : "<p>Energy data could not be read for this thermostat.</p>");
      }
      return page("Energy and automation", `${reports.join("")}<p>These are observations only. Nothing was changed. Individual eco+ feature controls depend on what this interface exposes.</p><a href='/app'>Return to connection</a>`);
    }
    if (path === "/app/check") {
      const unavailable = () => page("Connection needs attention", "<p>Your ecobee session may have expired or could not be restored. Reconnect ecobee from your connection page, then check again.</p><a href='/app'>Return to connection</a>");
      try {
        const response = await internal(env, session.userId, "/control", { method: "list", args: {}, tokenAllowsWrites: false });
        const result = await response.json() as { ok?: boolean; data?: { thermostats?: Thermostat[] } };
        if (!response.ok || !result.ok || !Array.isArray(result.data?.thermostats)) return unavailable();
        const thermostats = result.data.thermostats.map(thermostat => `<section><h2>${escapeHtml(String(thermostat.name))}</h2><p>Current temperature: <strong>${escapeHtml(String(thermostat.temperatureF))} °F</strong><br>Humidity: ${escapeHtml(String(thermostat.humidity))}%<br>Mode: ${escapeHtml(String(thermostat.mode))}<br>Connection: ${thermostat.connected ? "connected" : "offline"}</p></section>`).join("");
        return page("Thermostat connection verified", `${thermostats || "<p>Ecobee returned no thermostats.</p>"}<p><a href='/app'>Return to connection</a></p>`);
      } catch { return unavailable(); }
    }
    if (path === "/app/start") {
      const response = await internal(env, session.userId, "/start", {});
      const result = await response.json() as { liveViewUrl?: string; message?: string };
      if (!response.ok || !result.liveViewUrl) return page("Browser unavailable", "<p>The hosted browser could not start. Try again from your connection page.</p><a href='/app'>Return</a>");
      const live = new URL(result.liveViewUrl);
      if (live.protocol !== "https:") throw new Error("Unexpected Live View URL.");
      return page("Sign in to ecobee", `<p>Open your private hosted browser in a new tab and sign in to ecobee, including MFA. Return here and finish connecting. Anyone with the private browser link can access it until it expires; keep it private.</p><p><a class="button" href="${escapeHtml(live.href)}" target="_blank" rel="noopener noreferrer">Open private ecobee browser</a></p><form method="post" action="/app/finish">${hidden(session)}<button>Finish connecting</button></form><a href="/app">Return to connection</a>`);
    }
    const routes: Record<string, string> = { "/app/finish": "/finish", "/app/disconnect": "/disconnect", "/app/preferences": "/preferences" };
    if (routes[path]) {
      const response = await internal(env, session.userId, routes[path], path === "/app/preferences" ? { allowWrites: form.get("allowWrites") === "yes" } : {});
      if (!response.ok) return page("Connection needs attention", "<p>Sign in completely in the private browser, then try finishing again. Ecobee may require another login or block hosted browsers.</p><a href='/app'>Return to connection</a>");
      return redirect("/app");
    }
  }
  return new Response("Not found.", { status: 404 });
}

async function mcpFetch(request: Request, env: Env, ctx: ExecutionContext & { props: { userId: string; login: string }; auth: { scope: string[] } }) {
  if (new URL(request.url).pathname !== "/mcp") return new Response("Not found.", { status: 404 });
  const user = ctx.props;
  if (!user || !/^\d+$/.test(user.userId) || !allowedLogin(user.login, env.ALLOWED_GITHUB_USERS) || !ctx.auth.scope.includes("thermostat:read")) return new Response("Forbidden.", { status: 403 });
  const tokenAllowsWrites = ctx.auth.scope.includes("thermostat:write");
  const call = async (method: string, args?: unknown) => {
    const response = await internal(env, user.userId, "/control", { method, args, tokenAllowsWrites });
    const result = await response.json() as { ok: boolean; data: unknown; message?: string };
    if (!response.ok || !result.ok) throw new UserError(result.message ?? "Ecobee is not connected. Open the hosted OpenEcoBee connection page to sign in.");
    return result.data;
  };
  const controls: ThermostatControls = { list: () => call("list", {}), status: id => call("status", { thermostat_id: id }), setTemperature: input => call("setTemperature", input), setMode: (id, mode) => call("setMode", { thermostat_id: id, mode }), resume: id => call("resume", { thermostat_id: id }), feature: request => call("feature", request) };
  const server = createMcpServer(controls);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 65536 });
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  ctx.waitUntil(server.close());
  return response;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    try {
      const origin = new URL(env.PUBLIC_ORIGIN);
      if (origin.protocol !== "https:" || origin.origin !== env.PUBLIC_ORIGIN || new URL(request.url).origin !== origin.origin) return new Response("Configure PUBLIC_ORIGIN to this deployment's HTTPS origin.", { status: 503 });
      const provider = new OAuthProvider<Env>({ apiRoute: "/mcp", apiHandler: { fetch: mcpFetch as never }, defaultHandler: { fetch: defaultFetch }, authorizeEndpoint: "/authorize", tokenEndpoint: "/oauth/token", clientRegistrationEndpoint: "/oauth/register", scopesSupported: scopes, requiredScopes: ["thermostat:read"], resourceMetadata: { resource: `${env.PUBLIC_ORIGIN}/mcp`, authorization_servers: [env.PUBLIC_ORIGIN] }, accessTokenTTL: 3600, refreshTokenTTL: 30 * 86400 });
      return await provider.fetch(request, env, ctx);
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return redirect(error.redirectTo);
      return page("Connection could not finish", "<p>The connection expired or the service is not configured. <a href='/'>Start again</a>.</p>");
    }
  },
};
