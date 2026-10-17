import { chmod, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright";
import { PORTAL_URL, portalDiagnosticSuffix, runPortalOperation, type PortalErrorCode, type PortalOperation, type PortalResult } from "./portal.js";
import { UserError, type HvacMode, type TemperatureHold, type Thermostat, type ThermostatBackend } from "./types.js";

const MESSAGES: Record<PortalErrorCode, string> = {
  login_required: "Your Ecobee sign-in is missing or expired. Run openecobee login, then try again.",
  site_changed: "The Ecobee portal is not ready or its supported interface has changed. Sign in again; if this continues, the browser adapter needs an update.",
  invalid_response: "Ecobee returned an unexpected thermostat response. No change was sent; the browser adapter may need an update.",
  request_failed: "Ecobee did not accept the request. Check the thermostat in the Ecobee portal before trying again.",
  timeout: "Ecobee did not respond in time. No thermostat change was sent.",
  write_uncertain: "The thermostat change could not be confirmed. It may have applied. Check its current state before sending another change; this request was not retried.",
  thermostat_missing: "That thermostat is not available in the signed-in Ecobee account.",
  offline: "The thermostat is offline. Reconnect it before sending a change.",
  invalid_input: "The thermostat request was invalid. Choose 1–24 hours, until the next scheduled change, or until changed.",
  temperature_range: "Those temperatures exceed the thermostat's configured limits or minimum heat/cool separation.",
  demand_response: "An active demand response event is controlling this thermostat. Review it in the Ecobee portal before changing its settings.",
};

async function prepareProfile(profileDir: string): Promise<void> {
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await chmod(profileDir, 0o700);
}

async function launch(profileDir: string, headless: boolean): Promise<BrowserContext> {
  try {
    await prepareProfile(profileDir);
    if (!existsSync(chromium.executablePath())) {
      throw new UserError("The browser is not installed. Run npx playwright install chromium, then try again.");
    }
    return await chromium.launchPersistentContext(profileDir, {
      headless,
      acceptDownloads: false,
      timeout: 30_000,
    });
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError("The Ecobee browser could not start. Close other OpenEcoBee browser sessions using this profile and check that its folder is writable.");
  }
}

async function portalCall(page: Page, operation: PortalOperation): Promise<PortalResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      page.evaluate(runPortalOperation, operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new UserError(operation.type === "list"
          ? MESSAGES.timeout : MESSAGES.write_uncertain)), 60_000);
      }),
    ]);
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(operation.type === "list"
      ? "The Ecobee browser session was interrupted. Run openecobee login, then try again."
      : MESSAGES.write_uncertain);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A single persistent browser, with every page operation serialized. */
export class BrowserBackend implements ThermostatBackend {
  readonly kind = "browser" as const;
  private context?: BrowserContext;
  private page?: Page;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: { profileDir: string; headless?: boolean }) {}

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async getPage(): Promise<Page> {
    if (this.closed) throw new UserError("The thermostat connection is closed.");
    if (this.page && !this.page.isClosed()) return this.page;
    this.context = await launch(this.options.profileDir, this.options.headless ?? true);
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    this.page.setDefaultTimeout(25_000);
    try {
      await this.page.goto(PORTAL_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await this.page.waitForFunction(() => {
        const angular = (window as Window & { angular?: {
          element(element: Element): { injector(): { get(name: string): unknown } | undefined };
        } }).angular;
        if (!angular) return false;
        for (const element of [document.querySelector("[ng-app]"), document.body, document.documentElement]) {
          if (!element) continue;
          try { if (angular.element(element).injector()?.get("connectionManagerAPI")) return true; }
          catch { /* Angular may still be bootstrapping. */ }
        }
        return false;
      }, undefined, { timeout: 20_000 });
    } catch {
      await this.closeContext();
      throw new UserError("The Ecobee portal could not load. Check your connection and run openecobee login.");
    }
    return this.page;
  }

  private async perform(operation: PortalOperation): Promise<PortalResult> {
    const page = await this.getPage();
    let result: PortalResult;
    try { result = await portalCall(page, operation); }
    catch (error) { await this.closeContext(); throw error; }
    if (!result.ok) {
      if (["timeout", "write_uncertain", "login_required"].includes(result.error)) await this.closeContext();
      throw new UserError(MESSAGES[result.error] + portalDiagnosticSuffix(result.diagnostics));
    }
    return result;
  }

  listThermostats(): Promise<Thermostat[]> {
    return this.serialize(async () => {
      const result = await this.perform({ type: "list" });
      if (!("thermostats" in result)) throw new UserError(MESSAGES.invalid_response);
      return result.thermostats;
    });
  }

  setTemperature(id: string, hold: TemperatureHold): Promise<void> {
    return this.serialize(async () => { await this.perform({ type: "setTemperature", id, hold }); });
  }

  setMode(id: string, mode: HvacMode): Promise<void> {
    return this.serialize(async () => { await this.perform({ type: "setMode", id, mode }); });
  }

  resumeSchedule(id: string): Promise<void> {
    return this.serialize(async () => { await this.perform({ type: "resume", id }); });
  }

  private async closeContext(): Promise<void> {
    const context = this.context;
    this.page = undefined;
    this.context = undefined;
    if (context) {
      try { await context.close(); } catch { /* Do not disclose browser diagnostics or credentials. */ }
    }
  }

  close(): Promise<void> {
    return this.serialize(async () => { this.closed = true; await this.closeContext(); });
  }
}

/** The user enters credentials/MFA directly into Ecobee's visible browser. */
export async function login(profileDir: string): Promise<void> {
  const context = await launch(profileDir, false);
  try {
    const page = context.pages()[0] ?? await context.newPage();
    try { await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }); }
    catch { throw new UserError("The Ecobee sign-in page could not load. Check your connection and try again."); }
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      for (const candidate of context.pages()) {
        if (candidate.isClosed()) continue;
        const url = new URL(candidate.url());
        if (!["www.ecobee.com", "ecobee.com"].includes(url.hostname) || !url.pathname.startsWith("/consumerportal/")) continue;
        try {
          const result = await portalCall(candidate, { type: "list" });
          if (result.ok && "thermostats" in result) return;
        } catch { /* Navigation and MFA can replace the current document. */ }
      }
      if (!context.pages().length) throw new UserError("The sign-in browser was closed before Ecobee sign-in was verified.");
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    throw new UserError("Ecobee sign-in was not verified within 10 minutes. Run openecobee login to try again.");
  } finally {
    try { await context.close(); } catch { /* Preserve only the intended user-facing result. */ }
  }
}
