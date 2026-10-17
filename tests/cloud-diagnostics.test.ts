import { EventEmitter } from "node:events";
import type { Page } from "@cloudflare/playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capturePortalDiagnostics } from "../cloud/diagnostics.js";

const health = {
  storeReady: true, bootstrapComplete: true, bootstrapSuccess: true,
  reduxTokenExists: true, auth0CookieExists: true, reduxTokenMatchesCookie: true,
  reduxJwtExpiryKnown: true, reduxJwtExpired: false, cookieJwtExpiryKnown: true, cookieJwtExpired: false,
};
function setup() {
  const events = new EventEmitter();
  const evaluate = vi.fn(async () => health);
  const page = Object.assign(events, { evaluate });
  return { page, evaluate, diagnostic: capturePortalDiagnostics(page as unknown as Page) };
}
function request(url: string, method = "GET") {
  return { url: () => url, method: () => method, failure: vi.fn(() => ({ errorText: "PRIVATE URL AND TOKEN" })) };
}
function response(url: string, options: { status?: number; type?: string; code?: unknown; method?: string } = {}) {
  return {
    request: () => request(url, options.method),
    status: () => options.status ?? 200,
    headerValue: vi.fn(async () => options.type ?? "application/json"),
    json: vi.fn(async () => ({ status: { code: options.code ?? 0 }, private: "PRIVATE BODY TOKEN" })),
  };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("bounded portal diagnostics", () => {
  it("returns only fixed health labels and allowlisted HTTP/API categories", async () => {
    const { page, diagnostic } = setup();
    const read = response("https://api.ecobee.com/1/thermostat?token=PRIVATE-QUERY", { status: 500, code: 14 });
    page.emit("response", read);
    const result = await diagnostic.summary();
    expect(result).toContain("bootstrap=yes,success=yes,token=yes,cookie=yes,equal=yes,tokenExpired=no");
    expect(result).toContain("thermostat/GET/http=500/api=14/json");
    expect(result).not.toMatch(/PRIVATE|https:|ecobee\.com|token=PRIVATE/);
    expect(read.headerValue).toHaveBeenCalledExactlyOnceWith("content-type");
    expect(page.listenerCount("response")).toBe(0);
    expect(page.listenerCount("requestfailed")).toBe(0);
  });

  it("does not read any Auth0 response body even when it is JSON", async () => {
    const { page, diagnostic } = setup();
    const auth = response("https://auth.ecobee.com/authorize?state=PRIVATE", { status: 302 });
    page.emit("response", auth);
    expect(await diagnostic.summary()).toContain("auth/GET/http=302/api=none/json");
    expect(auth.json).not.toHaveBeenCalled();
  });

  it("filters unrelated hosts, paths, protocols and methods", async () => {
    const { page, diagnostic } = setup();
    for (const [url, method] of [
      ["https://api.ecobee.com.attacker.example/1/thermostat", "GET"],
      ["https://api.ecobee.com/1/thermostat/private", "GET"],
      ["https://auth.ecobee.com/login", "GET"],
      ["http://api.ecobee.com/1/thermostat", "GET"],
      ["https://api.ecobee.com/1/thermostat", "DELETE"],
      ["invalid", "GET"],
    ]) page.emit("response", response(url, { method }));
    expect(await diagnostic.summary()).toContain("network=none");
  });

  it("bounds capture to eight samples and validates numeric status ranges", async () => {
    const { page, diagnostic } = setup();
    for (let index = 0; index < 12; index++) page.emit("response", response("https://api.ecobee.com/1/thermostatSummary", { status: 999, code: 10000 }));
    const result = await diagnostic.summary();
    expect(result.match(/summary\/GET/g)).toHaveLength(8);
    expect(result).not.toMatch(/999|10000/);
    expect(result).toContain("http=none/api=none/json");
  });

  it("records request failure as a fixed flag without reading raw failure text", async () => {
    const { page, diagnostic } = setup();
    const failed = request("https://api.ecobee.com/1/thermostat?PRIVATE", "POST");
    page.emit("requestfailed", failed);
    const result = await diagnostic.summary();
    expect(result).toContain("thermostat/POST/failed");
    expect(result).not.toContain("PRIVATE");
    expect(failed.failure).not.toHaveBeenCalled();
  });

  it("classifies an HTML challenge without reading its contents", async () => {
    const { page, diagnostic } = setup();
    const blocked = response("https://api.ecobee.com/1/thermostat", { status: 403, type: "text/html; charset=utf-8" });
    page.emit("response", blocked);
    expect(await diagnostic.summary()).toContain("thermostat/GET/http=403/api=none/html");
    expect(blocked.json).not.toHaveBeenCalled();
  });

  it("never exposes browser or JSON parser rejection messages", async () => {
    const { page, evaluate, diagnostic } = setup();
    evaluate.mockRejectedValue(new Error("PRIVATE SESSION COOKIE"));
    const broken = response("https://api.ecobee.com/1/thermostat");
    broken.json.mockRejectedValue(new Error("PRIVATE API RESPONSE"));
    page.emit("response", broken);
    expect(await diagnostic.summary()).toBe("Portal diagnostics: health=unavailable; network=thermostat/GET/http=200/api=none/json.");
  });

  it("drains network observation for at most one second", async () => {
    vi.useFakeTimers();
    const { page, diagnostic } = setup();
    const hanging = response("https://api.ecobee.com/1/thermostat");
    hanging.json.mockImplementation(() => new Promise(() => undefined));
    page.emit("response", hanging);
    const summary = diagnostic.summary();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await summary).toContain("thermostat/GET/http=200/api=none/json/pending");
    expect(page.listenerCount("response")).toBe(0);
  });

  it("decodes only expiry inside the page and returns booleans", async () => {
    const { evaluate, diagnostic } = setup();
    const token = `header.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 60, private: "PRIVATE CLAIM" }))}.signature`;
    vi.stubGlobal("window", { ecobeeStore: { getState: () => ({ tokens: { token }, lifecycle: { isBootstrapComplete: true, isBootstrapSuccess: false } }) } });
    vi.stubGlobal("document", { cookie: `_TOKEN=${token}; unrelated=PRIVATE-COOKIE` });
    evaluate.mockImplementation(async (callback?: unknown) => (callback as () => typeof health)());
    const result = await diagnostic.summary();
    expect(result).toContain("bootstrap=yes,success=no,token=yes,cookie=yes,equal=yes,tokenExpired=yes,cookieExpired=yes");
    expect(result).not.toMatch(/PRIVATE|signature|header\./);
  });
});
