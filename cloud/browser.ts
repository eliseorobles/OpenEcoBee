import { DurableObject } from "cloudflare:workers";
import { acquire, connect, endpointURLString, type Browser, type BrowserContext, type Page } from "@cloudflare/playwright";
import { z } from "zod";
import { Controller } from "../src/controller.js";
import { PORTAL_URL, runPortalOperation, type PortalErrorCode, type PortalOperation } from "../src/portal.js";
import { UserError, type ThermostatBackend } from "../src/types.js";
import { decryptSession, encryptSession, type EncryptedSession } from "./crypto.js";

export interface BrowserEnv {
  BROWSER: BrowserRun;
  SESSION_ENCRYPTION_KEY: string;
}

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
type SavedSession = { state: EncryptedSession; verifiedAt: string };
type LoginSession = { sessionId: string; expiresAt: number };

const LOGIN_LIFETIME = 10 * 60_000;
const LIVE_VIEW_LIFETIME = 5 * 60_000;
const id = z.string().regex(/^[0-9]{1,32}$/);
const hold = z.object({ heatF: z.number().finite(), coolF: z.number().finite(), hours: z.number().int().min(1).max(24) }).strict();
const mode = z.enum(["off", "heat", "cool", "auto"]);
const rpcSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("list") }).strict(),
  z.object({ op: z.literal("setTemperature"), id, hold }).strict(),
  z.object({ op: z.literal("setMode"), id, mode }).strict(),
  z.object({ op: z.literal("resume"), id }).strict(),
]);
const controlSchema = z.object({
  method: z.enum(["list", "status", "setTemperature", "setMode", "resume"]),
  args: z.unknown(),
  tokenAllowsWrites: z.boolean(),
}).strict();
const targetSchema = z.object({ thermostat_id: id }).strict();
const modeSchema = targetSchema.extend({ mode });
const temperatureSchema = targetSchema.extend({
  heat: z.number().finite().optional(),
  cool: z.number().finite().optional(),
  unit: z.enum(["F", "C"]),
  hours: z.number().int().min(1).max(24),
});

const PORTAL_ERRORS: Record<PortalErrorCode, string> = {
  login_required: "Your ecobee session has expired. Reconnect from your OpenEcoBee account page.",
  site_changed: "The ecobee portal is not ready or has changed. Reconnect and try again.",
  invalid_response: "The ecobee portal returned an unsupported response.",
  request_failed: "The ecobee portal could not complete this request.",
  timeout: "The ecobee portal took too long to respond.",
  write_uncertain: "The change may have reached ecobee. Check the thermostat before sending another change.",
  thermostat_missing: "This thermostat is not available in your ecobee account.",
  offline: "The thermostat is offline. No change was sent.",
  invalid_input: "The thermostat request is invalid.",
  temperature_range: "The requested temperatures exceed the thermostat's configured limits or minimum gap.",
  demand_response: "A demand-response event is active. No change was sent.",
};

class PortalError extends Error {
  constructor(readonly code: PortalErrorCode) { super(PORTAL_ERRORS[code]); }
}

function response(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

/** One object is selected by the Worker from the verified, immutable user id. */
export class ThermostatSession extends DurableObject<BrowserEnv> {
  private queue: Promise<unknown> = Promise.resolve();

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  fetch(request: Request): Promise<Response> {
    return this.serial(async () => {
      try {
        const path = new URL(request.url).pathname;
        if (request.method === "GET" && path === "/status") {
          const [saved, allowWrites] = await Promise.all([
            this.ctx.storage.get<SavedSession>("saved"), this.ctx.storage.get<boolean>("allowWrites"),
          ]);
          return response({ connected: Boolean(saved), allowWrites: allowWrites === true, verifiedAt: saved?.verifiedAt ?? null });
        }
        if (request.method !== "POST") return response({ ok: false, error: "not_found" }, 404);
        if (path === "/start") return await this.startLogin();
        if (path === "/finish") return await this.finishLogin();
        if (path === "/disconnect") {
          await this.closeLogin();
          await this.ctx.storage.deleteAll();
          await this.ctx.storage.deleteAlarm();
          return response({ connected: false, allowWrites: false });
        }
        if (path === "/preferences") {
          const input = z.object({ allowWrites: z.boolean() }).strict().parse(await request.json());
          await this.ctx.storage.put("allowWrites", input.allowWrites);
          return response(input);
        }
        if (path === "/rpc") return await this.rpc(request);
        if (path === "/control") return await this.control(request);
        return response({ ok: false, error: "not_found" }, 404);
      } catch (error) {
        if (error instanceof PortalError) return response({ ok: false, error: error.code, message: error.message }, 409);
        if (error instanceof UserError) return response({ ok: false, error: "invalid_request", message: error.message }, 400);
        if (error instanceof z.ZodError || error instanceof SyntaxError) return response({ ok: false, error: "invalid_request", message: "Invalid thermostat request." }, 400);
        // Raw browser exceptions can contain URLs, cookies, and ecobee account data.
        return response({ ok: false, error: "browser_unavailable", message: "The hosted browser is unavailable. Reconnect or try again later." }, 503);
      }
    });
  }

  alarm(): Promise<void> {
    return this.serial(async () => {
      const login = await this.ctx.storage.get<LoginSession>("login");
      if (!login) return;
      if (login.expiresAt <= Date.now()) await this.closeLogin();
      else await this.ctx.storage.setAlarm(login.expiresAt);
    });
  }

  private async closeSession(sessionId: string): Promise<void> {
    try { await this.env.BROWSER.closeSession(sessionId); } catch { /* Session may already have expired. */ }
  }

  private async closeLogin(): Promise<void> {
    const login = await this.ctx.storage.get<LoginSession>("login");
    // Keep the reference if Cloudflare cannot confirm closure; a retry/alarm can
    // revoke the previously issued Live View connection rather than forgetting it.
    if (login && await this.env.BROWSER.getSession(login.sessionId)) {
      await this.env.BROWSER.closeSession(login.sessionId);
    }
    await this.ctx.storage.delete("login");
    await this.ctx.storage.deleteAlarm();
  }

  private async acquireSession(keepAlive: number): Promise<string> {
    const session = await acquire(this.env.BROWSER, {
      keep_alive: keepAlive,
      recording: false,
      // Guardrails apply to Live View as well as the automation connection.
      guardrails: {
        allowedDomains: ["ecobee.com", "*.ecobee.com", "cdn.auth0.com", "*.recaptcha.net", "www.google.com", "www.gstatic.com"],
        allowedDomainSets: ["common-cdns"],
      },
    });
    return session.sessionId;
  }

  private async persistentBrowser(sessionId: string): Promise<Browser> {
    const endpoint = new URL(endpointURLString(this.env.BROWSER, { sessionId }));
    endpoint.searchParams.set("persistent", "true");
    return connect(endpoint);
  }

  private async startLogin(): Promise<Response> {
    // Check the key before allocating a browser that could accept credentials.
    await encryptSession(this.env.SESSION_ENCRYPTION_KEY, null, this.ctx.id.toString());
    await this.closeLogin();
    const sessionId = await this.acquireSession(LOGIN_LIFETIME);
    const login = { sessionId, expiresAt: Date.now() + LOGIN_LIFETIME };
    await this.ctx.storage.put("login", login);
    await this.ctx.storage.setAlarm(login.expiresAt);
    let browser: Browser | undefined;
    try {
      browser = await this.persistentBrowser(sessionId);
      // A private browser belongs to exactly one tenant. Its default context
      // survives disconnect; Playwright incognito contexts do not.
      const context = browser.contexts()[0];
      if (!context) throw new Error("Persistent browser context missing.");
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await this.openHomepageSignIn(page);
      const cdp = await context.newCDPSession(page);
      const { targetInfo } = await cdp.send("Target.getTargetInfo");
      const view = await this.env.BROWSER.getLiveView(sessionId, {
        targetId: targetInfo.targetId,
        mode: "tab",
        expiresInMs: LIVE_VIEW_LIFETIME,
      });
      return response({ liveViewUrl: view.devtoolsFrontendUrl, expiresAt: new Date(login.expiresAt).toISOString() });
    } catch (error) {
      await this.closeLogin();
      throw error;
    } finally {
      // connect().close() disconnects. The dedicated browser keeps the login tab.
      if (browser) await browser.close().catch(() => undefined);
    }
  }

  private async openHomepageSignIn(page: Page): Promise<void> {
    const current = new URL(page.url());
    if (current.protocol !== "https:" || !["www.ecobee.com", "ecobee.com"].includes(current.hostname) ||
        current.pathname.startsWith("/consumerportal/")) return;
    // The unauthenticated portal can redirect to the public homepage. Its login
    // link opens a new tab, which a single-target Live View cannot follow.
    // Discover the official link and navigate this same page instead.
    const links = await page.locator('a[href^="https://auth.ecobee.com/authorize"]').evaluateAll(anchors =>
      anchors.slice(0, 20).map(anchor => anchor.getAttribute("href")));
    const approvedScopes = new Set(["openid", "smartRead", "smartWrite", "piiRead", "piiWrite", "deleteGrants"]);
    for (const href of links) {
      if (!href) continue;
      let destination: URL;
      try { destination = new URL(href); } catch { continue; }
      const parameters = destination.searchParams;
      const scope = parameters.get("scope")?.split(/\s+/).filter(Boolean) ?? [];
      if (destination.protocol !== "https:" || destination.hostname !== "auth.ecobee.com" ||
          destination.port || destination.username || destination.password || destination.hash ||
          destination.pathname !== "/authorize" ||
          parameters.getAll("redirect_uri").length !== 1 || parameters.get("redirect_uri") !== "https://www.ecobee.com/home/authCallback" ||
          parameters.getAll("audience").length !== 1 || parameters.get("audience") !== "https://prod.ecobee.com/api/v1" ||
          parameters.getAll("client_id").length !== 1 || !/^[A-Za-z0-9_-]{1,256}$/.test(parameters.get("client_id") ?? "") ||
          parameters.get("response_type") !== "token" || parameters.get("response_mode") !== "form_post" ||
          parameters.getAll("scope").length !== 1 || !scope.includes("openid") ||
          !scope.includes("smartRead") || !scope.includes("smartWrite") || scope.some(value => !approvedScopes.has(value))) continue;
      // Preserve the discovered request's scopes. Never add permissions, supply
      // a guessed client id, or silently follow new permissions after a site change.
      await page.goto(destination.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
      return;
    }
    throw new PortalError("site_changed");
  }

  private async finishLogin(): Promise<Response> {
    const login = await this.ctx.storage.get<LoginSession>("login");
    if (!login || login.expiresAt <= Date.now()) {
      await this.closeLogin();
      return response({ ok: false, error: "login_required", message: "Start a new ecobee sign-in session." }, 409);
    }
    const browser = await this.persistentBrowser(login.sessionId);
    try {
      const context = browser.contexts()[0];
      const page = context?.pages().find(page => page.url().startsWith("https://www.ecobee.com/consumerportal/") || page.url().startsWith("https://ecobee.com/consumerportal/"));
      if (!page) throw new PortalError("login_required");
      await this.waitForPortalReady(page);
      await this.portal(page, { type: "list" });
      await this.saveState(context);
      // Closing the whole browser also invalidates every issued Live View URL.
      await this.closeLogin();
      return response({ connected: true, allowWrites: await this.ctx.storage.get<boolean>("allowWrites") === true });
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  private async saveState(context: BrowserContext): Promise<void> {
    const storageState = await context.storageState({ indexedDB: true });
    await this.ctx.storage.put<SavedSession>("saved", {
      state: await encryptSession(this.env.SESSION_ENCRYPTION_KEY, storageState, this.ctx.id.toString()),
      verifiedAt: new Date().toISOString(),
    });
  }

  private async waitForPortalReady(page: Page): Promise<void> {
    try {
      await page.waitForFunction(() => {
        if (location.protocol !== "https:" || !["www.ecobee.com", "ecobee.com"].includes(location.hostname) ||
            !location.pathname.startsWith("/consumerportal/")) return false;
        const angular = (window as Window & {
          angular?: { element(element: Element | Document): { injector(): { get(name: string): unknown } | undefined } };
        }).angular;
        if (!angular) return false;
        for (const element of [document.querySelector("[ng-app]"), document.body, document.documentElement, document]) {
          if (!element) continue;
          try {
            const manager = angular.element(element).injector()?.get("connectionManagerAPI") as {
              loadTokens?: () => void; haveToken?: () => boolean;
            } | undefined;
            if (typeof manager?.loadTokens !== "function" || typeof manager.haveToken !== "function") continue;
            manager.loadTokens();
            if (manager.haveToken()) return true;
          } catch { /* Angular can exist before its injector and services finish bootstrapping. */ }
        }
        return false;
      }, undefined, { timeout: 15_000 });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
      // A known login redirect proves authentication is needed. A slow portal
      // bootstrap alone does not prove the saved login has expired.
      const current = new URL(page.url());
      if (current.protocol === "https:" && current.hostname === "auth.ecobee.com") {
        await this.ctx.storage.delete("saved");
        throw new PortalError("login_required");
      }
      throw new PortalError("site_changed");
    }
  }

  private async portal(page: Page, operation: PortalOperation) {
    let result;
    try {
      result = await page.evaluate(runPortalOperation, operation);
    } catch (error) {
      // Losing the browser connection cannot prove whether a dispatched write
      // reached ecobee. Never advise the client to retry that write blindly.
      if (operation.type !== "list") throw new PortalError("write_uncertain");
      throw error;
    }
    if (!result.ok) {
      if (result.error === "login_required") await this.ctx.storage.delete("saved");
      throw new PortalError(result.error);
    }
    return "thermostats" in result ? result.thermostats : null;
  }

  private async withBackend<T>(operation: (backend: ThermostatBackend) => Promise<T>): Promise<T> {
    const saved = await this.ctx.storage.get<SavedSession>("saved");
    if (!saved) throw new PortalError("login_required");
    const storageState = await decryptSession<StorageState>(this.env.SESSION_ENCRYPTION_KEY, saved.state, this.ctx.id.toString());
    const sessionId = await this.acquireSession(60_000);
    let browser: Browser | undefined;
    let writeDelivered = false;
    try {
      browser = await connect(this.env.BROWSER, sessionId);
      const context = await browser.newContext({ storageState });
      const page = await context.newPage();
      await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await this.waitForPortalReady(page);
      const backend: ThermostatBackend = {
        kind: "browser",
        listThermostats: async () => {
          const thermostats = await this.portal(page, { type: "list" });
          if (!thermostats) throw new PortalError("invalid_response");
          return thermostats;
        },
        setTemperature: async (id, hold) => { await this.portal(page, { type: "setTemperature", id, hold }); writeDelivered = true; },
        setMode: async (id, mode) => { await this.portal(page, { type: "setMode", id, mode }); writeDelivered = true; },
        resumeSchedule: async id => { await this.portal(page, { type: "resume", id }); writeDelivered = true; },
        close: async () => undefined,
      };
      const result = await operation(backend);
      await this.saveState(context);
      return result;
    } catch (error) {
      // A failed reread or state save must not encourage a duplicate command.
      if (writeDelivered) throw new PortalError("write_uncertain");
      throw error;
    } finally {
      if (browser) await browser.close().catch(() => undefined);
      await this.closeSession(sessionId);
    }
  }

  private async rpc(request: Request): Promise<Response> {
    const input = rpcSchema.parse(await request.json());
    if (input.op !== "list" && await this.ctx.storage.get<boolean>("allowWrites") !== true) throw new UserError("Thermostat changes are disabled in your OpenEcoBee account settings.");
    const data = await this.withBackend(async backend => {
      switch (input.op) {
        case "list": return backend.listThermostats();
        case "setTemperature": await backend.setTemperature(input.id, input.hold); return null;
        case "setMode": await backend.setMode(input.id, input.mode); return null;
        case "resume": await backend.resumeSchedule(input.id); return null;
      }
    });
    return response({ ok: true, data });
  }

  private async control(request: Request): Promise<Response> {
    const input = controlSchema.parse(await request.json());
    const allowWrites = input.tokenAllowsWrites && await this.ctx.storage.get<boolean>("allowWrites") === true;
    const data = await this.withBackend(async backend => {
      const controller = new Controller(backend, allowWrites);
      switch (input.method) {
        case "list": return controller.list();
        case "status": return controller.status(targetSchema.parse(input.args).thermostat_id);
        case "setTemperature": return controller.setTemperature(temperatureSchema.parse(input.args));
        case "setMode": {
          const args = modeSchema.parse(input.args);
          return controller.setMode(args.thermostat_id, args.mode);
        }
        case "resume": return controller.resume(targetSchema.parse(input.args).thermostat_id);
      }
    });
    return response({ ok: true, data });
  }
}
