import type { HvacMode, TemperatureHold, Thermostat } from "./types.js";

export const PORTAL_URL = "https://www.ecobee.com/consumerportal/index.html";

export type PortalOperation =
  | { type: "list" }
  | { type: "setTemperature"; id: string; hold: TemperatureHold }
  | { type: "setMode"; id: string; mode: HvacMode }
  | { type: "resume"; id: string };

export type PortalErrorCode =
  | "login_required"
  | "site_changed"
  | "invalid_response"
  | "request_failed"
  | "timeout"
  | "write_uncertain"
  | "thermostat_missing"
  | "offline"
  | "invalid_input"
  | "temperature_range"
  | "demand_response";

export type PortalResult =
  | { ok: true; thermostats: Thermostat[] }
  | { ok: true }
  | { ok: false; error: PortalErrorCode };

/**
 * Runs entirely inside the signed-in Ecobee page. It must have no runtime imports
 * or closure dependencies, because Playwright serializes this function.
 *
 * Observed in Ecobee's public consumer portal components bundle (2026-10-17):
 * https://www.ecobee.com/consumerportal/index.html
 * https://www.ecobee.com/consumerportal/scripts/ecobee.components.7d351bac.js
 * connectionManagerAPI has getThermostats(selection), setSettings(ids, settings),
 * and connectToReduxConnectionManager(action, arguments). Its Redux actions take
 * thermostatIds and resolve with the API JSON, including status.code. ecobeeAPI
 * itself is a legacy setApiKey stub and must not be used for these operations.
 * No endpoint, script, action name, or credential is supplied by the MCP client.
 */
export async function runPortalOperation(operation: PortalOperation): Promise<PortalResult> {
  type RecordValue = Record<string, unknown>;
  type Manager = {
    loadTokens(): void;
    haveToken(): boolean;
    getThermostats(selection: RecordValue): PromiseLike<unknown>;
    setSettings(ids: string[], settings: { hvacMode: HvacMode }): PromiseLike<unknown>;
    connectToReduxConnectionManager(action: "setHold" | "resume", args: unknown[]): PromiseLike<unknown>;
  };
  type AngularWindow = Window & {
    angular?: { element(element: Element | Document): { injector(): { get(name: string): unknown } | undefined } };
  };
  const fail = (error: PortalErrorCode): PortalResult => ({ ok: false, error });
  const record = (value: unknown): RecordValue | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as RecordValue : undefined;
  const finite = (value: unknown, low: number, high: number): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
  const safeText = (value: unknown, maximum: number): string =>
    typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, maximum) : "";
  const authFailure = (value: unknown): boolean => {
    const data = record(value);
    const nested = record(data?.data);
    const status = record(data?.status) ?? record(nested?.status);
    return status?.code === 14 || data?.status === 401 || data?.status === 403 ||
      data?.error === "invalid_token" || data?.error === "invalid_grant" ||
      nested?.error === "invalid_token" || nested?.error === "invalid_grant";
  };
  let writeStarted = false;
  const call = async (start: () => PromiseLike<unknown>): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(start),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject("portal_timeout"), 25_000);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const responseStatus = (value: unknown): "ok" | "auth" | "failed" | "invalid" => {
    if (authFailure(value)) return "auth";
    const status = record(record(value)?.status);
    if (!status || typeof status.code !== "number" || !Number.isInteger(status.code)) return "invalid";
    return status.code === 0 ? "ok" : "failed";
  };

  try {
    if (location.protocol !== "https:" ||
        !["www.ecobee.com", "ecobee.com"].includes(location.hostname) ||
        !location.pathname.startsWith("/consumerportal/")) return fail("login_required");
    const angular = (window as AngularWindow).angular;
    if (!angular) return fail("site_changed");
    let injector: { get(name: string): unknown } | undefined;
    for (const element of [document.querySelector("[ng-app]"), document.body, document.documentElement, document]) {
      if (!element) continue;
      try { injector = angular.element(element).injector(); } catch { /* Try the portal root next. */ }
      if (injector) break;
    }
    if (!injector) return fail("site_changed");
    let manager: Manager;
    try { manager = injector.get("connectionManagerAPI") as Manager; }
    catch { return fail("site_changed"); }
    if (!manager || typeof manager.loadTokens !== "function" || typeof manager.haveToken !== "function" || typeof manager.getThermostats !== "function" ||
        typeof manager.setSettings !== "function" || typeof manager.connectToReduxConnectionManager !== "function") {
      return fail("site_changed");
    }
    // Match the portal's own read method: load its cookie-backed session before
    // testing availability. No credentials or token values leave the page.
    manager.loadTokens();
    if (!manager.haveToken()) return fail("login_required");
    if (!operation || !["list", "setTemperature", "setMode", "resume"].includes(operation.type)) {
      return fail("invalid_input");
    }
    if (operation.type !== "list" && !/^[0-9]{1,32}$/.test(operation.id)) return fail("invalid_input");

    // The envelope matches the portal's own thermostat.getThermostats default.
    const response = await call(() => manager.getThermostats({ selection: {
      selectionType: "registered",
      includeRuntime: true,
      includeSettings: true,
      includeEvents: true,
      includeEquipmentStatus: true,
    } }));
    const status = responseStatus(response);
    if (status === "auth") return fail("login_required");
    if (status === "failed") return fail("request_failed");
    if (status !== "ok") return fail("invalid_response");
    const values = record(response)?.thermostatList;
    if (!Array.isArray(values) || values.length > 200) return fail("invalid_response");
    const thermostats: Thermostat[] = [];
    const seen = new Set<string>();
    let targetHasDemandResponse = false;
    for (const value of values) {
      const thermostat = record(value);
      const runtime = record(thermostat?.runtime);
      const settings = record(thermostat?.settings);
      const id = thermostat?.identifier;
      if (!thermostat || !runtime || !settings || typeof id !== "string" || !/^[0-9]{1,32}$/.test(id) || seen.has(id) ||
          !finite(runtime.actualTemperature, -1000, 2000) || !finite(runtime.actualHumidity, 0, 100) ||
          !finite(runtime.desiredHeat, -400, 2200) || !finite(runtime.desiredCool, -400, 2200) ||
          typeof runtime.connected !== "boolean" || !finite(settings.heatRangeLow, -400, 2200) ||
          !finite(settings.heatRangeHigh, -400, 2200) || !finite(settings.coolRangeLow, -400, 2200) ||
          !finite(settings.coolRangeHigh, -400, 2200) || !finite(settings.heatCoolMinDelta, 0, 500) ||
          settings.heatRangeLow > settings.heatRangeHigh || settings.coolRangeLow > settings.coolRangeHigh) {
        return fail("invalid_response");
      }
      seen.add(id);
      const allowedModes = ["off", "heat", "cool", "auto", "auxHeatOnly"];
      const mode = typeof settings.hvacMode === "string" && allowedModes.includes(settings.hvacMode)
        ? settings.hvacMode : "unknown";
      thermostats.push({
        id,
        name: safeText(thermostat.name, 120) || "Ecobee thermostat",
        temperatureF: runtime.actualTemperature / 10,
        humidity: runtime.actualHumidity,
        mode,
        heatF: runtime.desiredHeat / 10,
        coolF: runtime.desiredCool / 10,
        connected: runtime.connected,
        heatMinF: settings.heatRangeLow / 10,
        heatMaxF: settings.heatRangeHigh / 10,
        coolMinF: settings.coolRangeLow / 10,
        coolMaxF: settings.coolRangeHigh / 10,
        minDeltaF: settings.heatCoolMinDelta / 10,
        equipment: safeText(thermostat.equipmentStatus, 200),
      });
      if (operation.type !== "list" && operation.id === id && Array.isArray(thermostat.events)) {
        targetHasDemandResponse = thermostat.events.some(event => {
          const detail = record(event);
          return detail?.type === "demandResponse" && detail.running === true;
        });
      }
    }
    if (operation.type === "list") return { ok: true, thermostats };
    const target = thermostats.find(thermostat => thermostat.id === operation.id);
    if (!target) return fail("thermostat_missing");
    if (!target.connected) return fail("offline");
    if (targetHasDemandResponse) return fail("demand_response");
    let write: () => PromiseLike<unknown>;
    switch (operation.type) {
      case "setTemperature": {
        const hold = operation.hold;
        if (!hold || !finite(hold.heatF, -40, 220) || !finite(hold.coolF, -40, 220) ||
            !Number.isInteger(hold.hours) || hold.hours < 1 || hold.hours > 24) return fail("invalid_input");
        const heat = Math.round(hold.heatF * 10);
        const cool = Math.round(hold.coolF * 10);
        if (heat < target.heatMinF * 10 || heat > target.heatMaxF * 10 ||
            cool < target.coolMinF * 10 || cool > target.coolMaxF * 10 ||
            cool - heat < Math.round(target.minDeltaF * 10)) return fail("temperature_range");
        // Use exactly one existing API action. The UISetHold alternative can
        // wait on portal dialogs and is unsuitable for an unattended MCP call.
        write = () => manager.connectToReduxConnectionManager("setHold", [[operation.id], {
          coolHoldTemp: cool,
          heatHoldTemp: heat,
          holdType: "holdHours",
          holdHours: hold.hours,
          isTemperatureAbsolute: true,
          isTemperatureRelative: false,
        }]);
        break;
      }
      case "setMode":
        if (!["off", "heat", "cool", "auto"].includes(operation.mode)) return fail("invalid_input");
        write = () => manager.setSettings([operation.id], { hvacMode: operation.mode });
        break;
      case "resume":
        write = () => manager.connectToReduxConnectionManager("resume", [[operation.id]]);
        break;
    }
    writeStarted = true;
    const written = await call(write);
    const writtenStatus = responseStatus(written);
    if (writtenStatus === "auth") return fail("login_required");
    if (writtenStatus === "failed") return fail("request_failed");
    if (writtenStatus !== "ok") return fail("write_uncertain");
    return { ok: true };
  } catch (error: unknown) {
    if (authFailure(error)) return fail("login_required");
    if (writeStarted) return fail("write_uncertain");
    return fail(error === "portal_timeout" ? "timeout" : "request_failed");
  }
}
