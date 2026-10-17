import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { portalDiagnosticSuffix, runPortalOperation } from "../src/portal.js";

const rawThermostat = () => ({
  identifier: "123456789012",
  name: "Downstairs\u0000 thermostat",
  equipmentStatus: "fan,compCool1",
  runtime: { actualTemperature: 721, actualHumidity: 45, desiredHeat: 680, desiredCool: 760, connected: true },
  settings: { hvacMode: "auto", heatRangeLow: 450, heatRangeHigh: 790, coolRangeLow: 650, coolRangeHigh: 920, heatCoolMinDelta: 50 },
  events: [],
  location: { streetAddress: "PRIVATE ADDRESS" },
  houseDetails: { ownerName: "PRIVATE OWNER" },
});

describe("Ecobee page adapter", () => {
  let thermostat: ReturnType<typeof rawThermostat>;
  let manager: {
    loadTokens: ReturnType<typeof vi.fn>;
    haveToken: ReturnType<typeof vi.fn>;
    getThermostats: ReturnType<typeof vi.fn>;
    setSettings: ReturnType<typeof vi.fn>;
    connectToReduxConnectionManager: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    thermostat = rawThermostat();
    manager = {
      loadTokens: vi.fn(),
      haveToken: vi.fn(() => true),
      getThermostats: vi.fn(async () => ({ status: { code: 0 }, thermostatList: [thermostat] })),
      setSettings: vi.fn(async () => ({ status: { code: 0 } })),
      connectToReduxConnectionManager: vi.fn(async () => ({ status: { code: 0 } })),
    };
    const element = {};
    vi.stubGlobal("document", { body: element, documentElement: element, querySelector: () => element });
    vi.stubGlobal("location", { protocol: "https:", hostname: "www.ecobee.com", pathname: "/consumerportal/index.html" });
    vi.stubGlobal("window", { angular: { element: () => ({ injector: () => ({ get: (name: string) => {
      if (name !== "connectionManagerAPI") throw new Error("unknown service");
      return manager;
    } }) }) } });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("normalizes canonical temperatures and excludes account and household details", async () => {
    const result = await runPortalOperation({ type: "list" });
    expect(result).toEqual({ ok: true, thermostats: [{
      id: "123456789012", name: "Downstairs thermostat", temperatureF: 72.1, humidity: 45,
      mode: "auto", heatF: 68, coolF: 76, connected: true,
      heatMinF: 45, heatMaxF: 79, coolMinF: 65, coolMaxF: 92, minDeltaF: 5, equipment: "fan,compCool1",
    }] });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(manager.getThermostats).toHaveBeenCalledWith({ selection: {
      selectionType: "registered", includeRuntime: true, includeSettings: true,
      includeEvents: true, includeEquipmentStatus: true,
    } });
  });

  it("dispatches one bounded temperature hold with exact portal argument names", async () => {
    expect(await runPortalOperation({ type: "setTemperature", id: thermostat.identifier,
      hold: { heatF: 68.04, coolF: 76.04, hours: 2 } })).toEqual({ ok: true });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("setHold", [[thermostat.identifier], {
      coolHoldTemp: 760, heatHoldTemp: 680, holdType: "holdHours", holdHours: 2,
      isTemperatureAbsolute: true, isTemperatureRelative: false,
    }]);
  });

  it.each([
    ["indefinite", "indefinite"],
    ["next_transition", "nextTransition"],
  ] as const)("maps %s holds to the official API without supplying a timed duration", async (holdType, apiHoldType) => {
    expect(await runPortalOperation({ type: "setTemperature", id: thermostat.identifier,
      hold: { heatF: 68, coolF: 76, holdType } })).toEqual({ ok: true });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("setHold", [[thermostat.identifier], {
      coolHoldTemp: 760, heatHoldTemp: 680, holdType: apiHoldType,
      isTemperatureAbsolute: true, isTemperatureRelative: false,
    }]);
  });

  it("preserves an inactive 67 F heat setpoint when holding Cool at 65 F indefinitely", async () => {
    thermostat.settings.hvacMode = "cool";
    thermostat.runtime.desiredHeat = 670;
    expect(await runPortalOperation({ type: "setTemperature", id: thermostat.identifier,
      hold: { heatF: 67, coolF: 65, holdType: "indefinite" } })).toEqual({ ok: true });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("setHold", [[thermostat.identifier], {
      coolHoldTemp: 650, heatHoldTemp: 670, holdType: "indefinite",
      isTemperatureAbsolute: true, isTemperatureRelative: false,
    }]);
  });

  it.each([
    { holdType: "hours", hours: 0 },
    { holdType: "hours", hours: 25 },
    { holdType: "hours" },
    { holdType: "hours", hours: 1.5 },
    { holdType: "indefinite", hours: 2 },
    { holdType: "next_transition", hours: 2 },
    { holdType: "unknown", hours: 2 },
    { holdType: null, hours: 2 },
  ])("refuses inconsistent hold duration before sending a write (%j)", async duration => {
    expect(await runPortalOperation({ type: "setTemperature", id: thermostat.identifier,
      hold: { heatF: 68, coolF: 76, ...duration } as never })).toEqual({ ok: false, error: "invalid_input" });
    expect(manager.connectToReduxConnectionManager).not.toHaveBeenCalled();
  });

  it("still applies the thermostat's range limits in Cool mode", async () => {
    thermostat.settings.hvacMode = "cool";
    expect(await runPortalOperation({ type: "setTemperature", id: thermostat.identifier,
      hold: { heatF: 67, coolF: 64, holdType: "indefinite" } })).toEqual({ ok: false, error: "temperature_range" });
    expect(manager.connectToReduxConnectionManager).not.toHaveBeenCalled();
  });

  it("maps mode and resume to their distinct existing portal methods", async () => {
    expect(await runPortalOperation({ type: "setMode", id: thermostat.identifier, mode: "heat" })).toEqual({ ok: true });
    expect(manager.setSettings).toHaveBeenCalledExactlyOnceWith([thermostat.identifier], { hvacMode: "heat" });
    expect(await runPortalOperation({ type: "resume", id: thermostat.identifier })).toEqual({ ok: true });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("resume", [[thermostat.identifier]]);
  });

  it.each([14, 6, 100])("rejects API status %i without forwarding raw messages", async code => {
    manager.getThermostats.mockResolvedValue({ status: { code, message: "PRIVATE TOKEN" }, thermostatList: [thermostat] });
    expect(await runPortalOperation({ type: "list" })).toEqual({ ok: false, error: code === 14 ? "login_required" : "request_failed", diagnostics: { phase: "read", apiCode: code } });
  });

  it.each(["450", undefined, NaN, Infinity, -10000])("refuses malformed thermostat limits rather than supplying defaults (%s)", async value => {
    (thermostat.settings as Record<string, unknown>).heatRangeLow = value;
    expect(await runPortalOperation({ type: "setMode", id: thermostat.identifier, mode: "heat" }))
      .toEqual({ ok: false, error: "invalid_response" });
    expect(manager.setSettings).not.toHaveBeenCalled();
  });

  it("rejects missing status even when thermostat data appears valid", async () => {
    manager.getThermostats.mockResolvedValue({ thermostatList: [thermostat] });
    expect(await runPortalOperation({ type: "list" })).toEqual({ ok: false, error: "invalid_response", diagnostics: { phase: "read" } });
  });

  it("loads browser session state before testing whether it is signed in", async () => {
    manager.haveToken.mockReturnValue(false);
    expect(await runPortalOperation({ type: "list" })).toEqual({ ok: false, error: "login_required" });
    expect(manager.loadTokens).toHaveBeenCalledOnce();
    expect(manager.getThermostats).not.toHaveBeenCalled();
  });

  it("does not write to an offline thermostat", async () => {
    thermostat.runtime.connected = false;
    expect(await runPortalOperation({ type: "resume", id: thermostat.identifier })).toEqual({ ok: false, error: "offline" });
    expect(manager.connectToReduxConnectionManager).not.toHaveBeenCalled();
  });

  it.each([
    { heatF: 80, coolF: 87, hours: 2 },
    { heatF: 68, coolF: 70, hours: 2 },
  ])("validates the thermostat's actual limits and separation immediately before writing", async hold => {
    expect(await runPortalOperation({ type: "setTemperature", id: thermostat.identifier, hold }))
      .toEqual({ ok: false, error: "temperature_range" });
    expect(manager.connectToReduxConnectionManager).not.toHaveBeenCalled();
  });

  it("reports an unconfirmed write without retrying or leaking its underlying rejection", async () => {
    manager.setSettings.mockRejectedValue(new Error("PRIVATE TOKEN, URL, COOKIE"));
    expect(await runPortalOperation({ type: "setMode", id: thermostat.identifier, mode: "off" }))
      .toEqual({ ok: false, error: "write_uncertain", diagnostics: { phase: "write" } });
    expect(manager.setSettings).toHaveBeenCalledOnce();
  });

  it("requires explicit success status on writes", async () => {
    manager.setSettings.mockResolvedValue({ status: { code: 6 } });
    expect(await runPortalOperation({ type: "setMode", id: thermostat.identifier, mode: "off" }))
      .toEqual({ ok: false, error: "request_failed", diagnostics: { phase: "write", apiCode: 6 } });
    expect(manager.setSettings).toHaveBeenCalledOnce();
  });

  it("bounds a hanging read and sends no write", async () => {
    vi.useFakeTimers();
    manager.getThermostats.mockImplementation(() => new Promise(() => undefined));
    const pending = runPortalOperation({ type: "setMode", id: thermostat.identifier, mode: "off" });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await pending).toEqual({ ok: false, error: "timeout", diagnostics: { phase: "read" } });
    expect(manager.setSettings).not.toHaveBeenCalled();
  });

  it("fails closed if the portal service is missing", async () => {
    vi.stubGlobal("window", { angular: { element: () => ({ injector: () => ({ get: () => undefined }) }) } });
    expect(await runPortalOperation({ type: "list" })).toEqual({ ok: false, error: "site_changed" });
  });

  it("returns only numeric read diagnostics from a rejected nested API response", async () => {
    manager.getThermostats.mockRejectedValue({
      data: { status: { code: 5, message: "PRIVATE TOKEN" }, owner: "PRIVATE OWNER" },
      response: { status: 503, url: "https://private.example/?token=PRIVATE" },
      message: "PRIVATE COOKIE",
    });
    const result = await runPortalOperation({ type: "list" });
    expect(result).toEqual({ ok: false, error: "request_failed", diagnostics: { phase: "read", apiCode: 5, httpStatus: 503 } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(manager.getThermostats).toHaveBeenCalledOnce();
  });

  it("includes bounded HTTP authentication status while keeping the existing login failure", async () => {
    manager.getThermostats.mockRejectedValue({ status: 401, data: { status: { code: 14, message: "PRIVATE" } } });
    expect(await runPortalOperation({ type: "list" })).toEqual({
      ok: false, error: "login_required", diagnostics: { phase: "read", apiCode: 14, httpStatus: 401 },
    });
  });

  it.each([-1, 10000, 3.5, NaN, "PRIVATE TOKEN"])("drops an invalid API diagnostic (%s)", async code => {
    manager.getThermostats.mockRejectedValue({ status: 99, data: { status: { code } }, response: { status: 600 }, message: "PRIVATE" });
    expect(await runPortalOperation({ type: "list" })).toEqual({ ok: false, error: "request_failed", diagnostics: { phase: "read" } });
  });

  it("keeps an interrupted write uncertain with safe diagnostics and no retry", async () => {
    manager.setSettings.mockRejectedValue({ status: 503, data: { status: { code: 5, message: "PRIVATE" } } });
    expect(await runPortalOperation({ type: "setMode", id: thermostat.identifier, mode: "off" })).toEqual({
      ok: false, error: "write_uncertain", diagnostics: { phase: "write", apiCode: 5, httpStatus: 503 },
    });
    expect(manager.setSettings).toHaveBeenCalledOnce();
  });

  it("keeps a timed-out write uncertain and does not retry", async () => {
    vi.useFakeTimers();
    manager.setSettings.mockImplementation(() => new Promise(() => undefined));
    const pending = runPortalOperation({ type: "setMode", id: thermostat.identifier, mode: "off" });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await pending).toEqual({ ok: false, error: "write_uncertain", diagnostics: { phase: "write" } });
    expect(manager.setSettings).toHaveBeenCalledOnce();
  });

  it("formats only approved diagnostic words and bounded integers", () => {
    expect(portalDiagnosticSuffix({ phase: "read", apiCode: 5, httpStatus: 401, message: "PRIVATE" }))
      .toBe(" (read; ecobee API code 5; HTTP 401)");
    expect(portalDiagnosticSuffix({ phase: "write", apiCode: "PRIVATE", httpStatus: 600, url: "PRIVATE" })).toBe(" (write)");
    expect(portalDiagnosticSuffix({ phase: "PRIVATE", apiCode: 5 })).toBe("");
  });
});
