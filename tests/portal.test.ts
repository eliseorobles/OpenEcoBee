import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPortalOperation } from "../src/portal.js";

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

  it("maps mode and resume to their distinct existing portal methods", async () => {
    expect(await runPortalOperation({ type: "setMode", id: thermostat.identifier, mode: "heat" })).toEqual({ ok: true });
    expect(manager.setSettings).toHaveBeenCalledExactlyOnceWith([thermostat.identifier], { hvacMode: "heat" });
    expect(await runPortalOperation({ type: "resume", id: thermostat.identifier })).toEqual({ ok: true });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("resume", [[thermostat.identifier]]);
  });

  it.each([14, 6, 100])("rejects API status %i without forwarding raw messages", async code => {
    manager.getThermostats.mockResolvedValue({ status: { code, message: "PRIVATE TOKEN" }, thermostatList: [thermostat] });
    expect(await runPortalOperation({ type: "list" })).toEqual({ ok: false, error: code === 14 ? "login_required" : "request_failed" });
  });

  it.each(["450", undefined, NaN, Infinity, -10000])("refuses malformed thermostat limits rather than supplying defaults (%s)", async value => {
    (thermostat.settings as Record<string, unknown>).heatRangeLow = value;
    expect(await runPortalOperation({ type: "setMode", id: thermostat.identifier, mode: "heat" }))
      .toEqual({ ok: false, error: "invalid_response" });
    expect(manager.setSettings).not.toHaveBeenCalled();
  });

  it("rejects missing status even when thermostat data appears valid", async () => {
    manager.getThermostats.mockResolvedValue({ thermostatList: [thermostat] });
    expect(await runPortalOperation({ type: "list" })).toEqual({ ok: false, error: "invalid_response" });
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
      .toEqual({ ok: false, error: "write_uncertain" });
    expect(manager.setSettings).toHaveBeenCalledOnce();
  });

  it("requires explicit success status on writes", async () => {
    manager.setSettings.mockResolvedValue({ status: { code: 6 } });
    expect(await runPortalOperation({ type: "setMode", id: thermostat.identifier, mode: "off" }))
      .toEqual({ ok: false, error: "request_failed" });
    expect(manager.setSettings).toHaveBeenCalledOnce();
  });

  it("bounds a hanging read and sends no write", async () => {
    vi.useFakeTimers();
    manager.getThermostats.mockImplementation(() => new Promise(() => undefined));
    const pending = runPortalOperation({ type: "setMode", id: thermostat.identifier, mode: "off" });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await pending).toEqual({ ok: false, error: "timeout" });
    expect(manager.setSettings).not.toHaveBeenCalled();
  });

  it("fails closed if the portal service is missing", async () => {
    vi.stubGlobal("window", { angular: { element: () => ({ injector: () => ({ get: () => undefined }) }) } });
    expect(await runPortalOperation({ type: "list" })).toEqual({ ok: false, error: "site_changed" });
  });
});
