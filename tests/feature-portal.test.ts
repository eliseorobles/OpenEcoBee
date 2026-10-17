import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runFeatureOperation } from "../src/feature-portal.js";
import { advancedSettingsKeys, parseFeatureRequest, writableSettingsKeys } from "../src/features.js";

const thermostatId = "123456789012";
const makeThermostat = () => ({
  identifier: thermostatId, name: "Home", thermostatTime: "2026-10-17 14:00:00", runtime: { connected: true, actualTemperature: 721, rawTemperature: 719, desiredHeat: 680, desiredCool: 760 },
  settings: { hvacMode: "auto", heatRangeLow: 450, heatRangeHigh: 790, coolRangeLow: 650, coolRangeHigh: 920, heatCoolMinDelta: 50,
    autoAway: true, followMeComfort: false, smartCirculation: false, fanMinOnTime: 0, fanSpeed: "optimized", backlightOnIntensity: 5, tempCorrection: 0, disablePreHeating: false, disablePreCooling: true, drAccept: "askMe", installerCodeRequired: false,
    userAccessCode: "PRIVATE PIN", userAccessSetting: "PRIVATE PERMISSIONS", token: "PRIVATE TOKEN", installerCode: "PRIVATE INSTALLER CODE", pin: "PRIVATE PIN2", credentials: "PRIVATE CREDENTIALS" },
  program: { schedule: Array.from({ length: 7 }, () => Array(48).fill("home")), climates: [
    { climateRef: "home", name: "Home", heatTemp: 680, coolTemp: 760, heatFan: "auto", coolFan: "auto", sensors: [{ id: "rs:100" }] },
    { climateRef: "away", name: "Away", heatTemp: 620, coolTemp: 820, owner: "system" },
  ], currentClimateRef: "home" },
  remoteSensors: [{ id: "rs:100", name: "Bedroom", capability: [{ id: "1", type: "temperature", value: "710" }] }],
  events: [{ type: "vacation", name: "Holiday", running: false, isIndefinite: false }],
  alerts: [{ acknowledgeRef: "ack-1", text: "Replace filter" }],
  energy: { energyFeatureState: "enabled", feelsLikeMode: "humidex", tou: { featureState: "off", savings: "basic" }, accessToken: "PRIVATE TOKEN" },
  equipmentStatus: "fan", capabilities: { fanCapabilities: { speedOptions: ["LOW", "MEDIUM_LOW", "MEDIUM", "MEDIUM_HIGH", "HIGH", "OPTIMIZED"] } },
  houseDetails: { size: 2000 }, location: { streetAddress: "PRIVATE ADDRESS", city: "Test City", timeZone: "America/Chicago", isDaylightSaving: true },
  devices: [{ name: "Plug", serialNumber: "PRIVATE SERIAL" }], audio: { enabled: true, playbackVolume: 50, microphoneEnabled: false, soundTickVolume: 5, soundAlertVolume: 5 },
  notificationSettings: { emailNotificationsEnabled: true, emailAddresses: ["PRIVATE@example.com"],
    equipment: [{ type: "furnaceFilter", enabled: true, filterLife: 6, filterLifeUnits: "month", filterLastChanged: "2026-10-01", remindMeDate: "2027-04-01" }],
    general: [{ type: "temp", enabled: true, remindTechnician: false }],
    limit: [{ type: "lowTemp", limit: 500, enabled: true }, { type: "highTemp", limit: 900, enabled: true },
      { type: "lowHumidity", limit: 30, enabled: true }, { type: "highHumidity", limit: 70, enabled: true }],
  },
});

describe("fixed browser feature operations", () => {
  let target: ReturnType<typeof makeThermostat>;
  let manager: {
    getThermostats: ReturnType<typeof vi.fn>;
    connectToReduxConnectionManager: ReturnType<typeof vi.fn>;
    getGroups: ReturnType<typeof vi.fn>;
    getThermostatRuntime: ReturnType<typeof vi.fn>;
  };
  const invoke = (name: string, input: Record<string, unknown> = {}) => runFeatureOperation({ name, input: { thermostat_id: thermostatId, ...input } });
  beforeEach(() => {
    target = makeThermostat();
    manager = {
      getThermostats: vi.fn(async () => ({ status: { code: 0 }, thermostatList: [target] })),
      connectToReduxConnectionManager: vi.fn(async () => ({ status: { code: 0 } })),
      getGroups: vi.fn(async () => ({ status: { code: 0 }, groups: [{ groupRef: "group-1", groupName: "Home", thermostats: [thermostatId] }] })),
      getThermostatRuntime: vi.fn(async () => ({ status: { code: 0 }, reportList: [{ rowList: ["2026-10-17,00:00:00,auto"] }], sensorList: [] })),
    };
    const element = {};
    vi.stubGlobal("location", { protocol: "https:", hostname: "www.ecobee.com", pathname: "/consumerportal/index.html" });
    vi.stubGlobal("document", { querySelector: () => element, body: element, documentElement: element });
    vi.stubGlobal("window", { angular: { element: () => ({ injector: () => ({ get: () => manager }) }) } });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("returns only requested sections and strips nested credentials and security codes", async () => {
    const result = await invoke("get_settings");
    expect(result).toMatchObject({ ok: true, data: { thermostat_id: thermostatId, settings: { autoAway: true, installerCodeRequired: false } } });
    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain("PRIVATE");
    expect(rendered).not.toContain("houseDetails");
    expect(rendered).not.toContain("userAccessSetting");
    expect(manager.connectToReduxConnectionManager).not.toHaveBeenCalled();
  });

  it("maps supported explicit detail sections to verified include flags and marks unavailable electricity", async () => {
    const result = await invoke("get_thermostat_details", { sections: ["devices", "audio", "location", "electricity"] });
    expect(result).toMatchObject({ ok: true, data: { devices: [{ name: "Plug" }], location: { city: "Test City" }, electricity: null, unavailable_sections: ["electricity"] } });
    expect(manager.getThermostats).toHaveBeenCalledWith({ selection: { selectionType: "registered", includeRuntime: true, includeSettings: true, includeDevice: true, includeAudio: true, includeLocation: true } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("reports energy values verbatim and separates dry bulb from displayed temperature", async () => {
    const result = await invoke("get_energy_status");
    expect(result).toMatchObject({ ok: true, data: { energyFeatureState: "enabled", masterWriteSupported: true, displayedTemperatureF: 72.1, dryBulbTemperatureF: 71.9, energy: { tou: { featureState: "off", savings: "basic" } } } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("does not infer unsupported master state values or dispatch a write", async () => {
    target.energy.energyFeatureState = "off";
    expect(await invoke("set_eco_plus", { enabled: false })).toMatchObject({ ok: true, data: { supported: false, applied: false } });
    expect(manager.connectToReduxConnectionManager).not.toHaveBeenCalled();
  });

  it("writes exactly the verified eco master property and performs a bounded readback", async () => {
    manager.connectToReduxConnectionManager.mockImplementation(async () => { target.energy.energyFeatureState = "disabled"; return { status: { code: 0 } }; });
    expect(await invoke("set_eco_plus", { enabled: false })).toMatchObject({ ok: true, data: { delivery: "accepted", verification: "observed", energyFeatureState: "disabled" } });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("updateThermostatProperties", [[thermostatId], { energy: { energyFeatureState: "disabled" } }]);
    expect(manager.getThermostats).toHaveBeenCalledTimes(2);
  });

  it.each(["set_fan", "set_comfort_setting", "update_settings", "send_message", "set_eco_plus"])("verifies account ownership before %s", async name => {
    manager.getThermostats.mockResolvedValue({ status: { code: 0 }, thermostatList: [{ ...target, identifier: "999999999999" }] });
    expect(await invoke(name, { enabled: false })).toEqual({ ok: false, error: "thermostat_missing" });
    expect(manager.connectToReduxConnectionManager).not.toHaveBeenCalled();
  });

  it("uses an existing climate reference for a comfort hold with explicit duration", async () => {
    expect(await invoke("set_comfort_setting", { climate_ref: "away", hold_type: "hours", hours: 2 })).toMatchObject({ ok: true });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("setHold", [[thermostatId], { holdClimateRef: "away", holdType: "holdHours", holdHours: 2 }]);
  });

  it("rejects unknown climate references and missing durations", async () => {
    expect(await invoke("set_comfort_setting", { climate_ref: "missing", hold_type: "indefinite" })).toEqual({ ok: false, error: "invalid_input" });
    expect(await invoke("set_comfort_setting", { climate_ref: "home" })).toEqual({ ok: false, error: "invalid_input" });
    expect(manager.connectToReduxConnectionManager).not.toHaveBeenCalled();
  });

  it("updates only the selected comfort setting and preserves the rest of its program", async () => {
    expect(await invoke("update_comfort_setting", { climate_ref: "home", heat: 20, cool: 25, unit: "C", sensor_ids: ["rs:100"], heat_fan: "on" })).toMatchObject({ ok: true });
    const [, [ids, properties]] = manager.connectToReduxConnectionManager.mock.calls[0];
    expect(ids).toEqual([thermostatId]);
    expect(properties.program.schedule).toEqual(target.program.schedule);
    expect(properties.program.climates[0]).toMatchObject({ climateRef: "home", heatTemp: 680, coolTemp: 770, sensors: [{ id: "rs:100:1" }], heatFan: "on" });
    expect(properties.program.climates[1]).toEqual(target.program.climates[1]);
    expect(target.program.climates[0].coolTemp).toBe(760);
  });

  it("renames an existing comfort setting without changing its reference, schedule or temperatures", async () => {
    expect(await invoke("update_comfort_setting", { climate_ref: "home", name: "At home", unit: "F" })).toMatchObject({ ok: true });
    const properties = manager.connectToReduxConnectionManager.mock.calls[0][1][1];
    expect(properties.program.schedule).toEqual(target.program.schedule);
    expect(properties.program.climates[0]).toMatchObject({ climateRef: "home", name: "At home", heatTemp: 680, coolTemp: 760 });
    expect(target.program.climates[0].name).toBe("Home");
    expect(await invoke("update_comfort_setting", { climate_ref: "home", name: "Away", unit: "F" })).toEqual({ ok: false, error: "invalid_input" });
  });

  it("creates a unique comfort profile without guessing its server-assigned reference or changing the schedule", async () => {
    const beforeSchedule = structuredClone(target.program.schedule);
    manager.connectToReduxConnectionManager.mockImplementation(async (_action: string, args: unknown[]) => {
      const program = (args[1] as { program: typeof target.program }).program;
      const created = program.climates[program.climates.length - 1];
      target.program.climates.push({ ...created, climateRef: "generated-7" });
      return { status: { code: 0 } };
    });
    expect(await invoke("create_comfort_setting", { name: "Office", heat: 68, cool: 76, unit: "F", is_occupied: true, vent: "off" })).toMatchObject({ ok: true, data: { delivery: "accepted", verification: "observed", verification_scope: "created_reference", climate_ref: "generated-7" } });
    const sent = manager.connectToReduxConnectionManager.mock.calls[0][1][1].program;
    expect(sent.schedule).toEqual(beforeSchedule);
    expect(sent.climates[2]).toMatchObject({ name: "Office", owner: "user", type: "program", isOccupied: true, isOptimized: true, heatTemp: 680, coolTemp: 760, sensors: [{ id: "rs:100:1" }] });
    expect(sent.climates[2]).not.toHaveProperty("climateRef");
    expect(target.program.schedule).toEqual(beforeSchedule);
  });

  it("does not delete default, scheduled or held comfort settings", async () => {
    expect(await invoke("delete_comfort_setting", { climate_ref: "home" })).toEqual({ ok: false, error: "invalid_input" });
    target.program.climates.push({ ...target.program.climates[0], climateRef: "custom", name: "Custom" });
    target.program.schedule[0][0] = "custom";
    expect(await invoke("delete_comfort_setting", { climate_ref: "custom" })).toEqual({ ok: false, error: "invalid_input" });
    expect(manager.connectToReduxConnectionManager).not.toHaveBeenCalled();
    target.program.schedule[0][0] = "home";
    expect(await invoke("delete_comfort_setting", { climate_ref: "custom" })).toMatchObject({ ok: true, data: { delivery: "accepted" } });
    expect(manager.connectToReduxConnectionManager.mock.calls[0][1][1].program.climates.map((climate: { climateRef: string }) => climate.climateRef)).toEqual(["home", "away"]);
  });

  it("updates all documented comfort metadata while preserving its immutable reference", async () => {
    expect(await invoke("update_comfort_setting", { climate_ref: "home", unit: "F", is_occupied: false, is_optimized: true, vent: "minontime", ventilator_min_on_time: 10, colour: 0x123456 })).toMatchObject({ ok: true });
    expect(manager.connectToReduxConnectionManager.mock.calls[0][1][1].program.climates[0]).toMatchObject({ climateRef: "home", isOccupied: false, isOptimized: true, vent: "minontime", ventilatorMinOnTime: 10, colour: 0x123456 });
  });

  it("renames only the owned thermostat using the portal's verified 20-character bound", async () => {
    expect(await invoke("rename_thermostat", { name: "a".repeat(21) })).toEqual({ ok: false, error: "invalid_input" });
    expect(await invoke("rename_thermostat", { name: "Main floor" })).toMatchObject({ ok: true, data: { delivery: "accepted", verification: "pending" } });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("updateThermostatProperties", [[thermostatId], { name: "Main floor" }]);
  });

  it("uses the verified inverse boolean polarity for Smart Recovery preferences", async () => {
    expect(await invoke("set_smart_recovery", { heat_enabled: true, cool_enabled: false })).toMatchObject({ ok: true });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("updateThermostatProperties", [[thermostatId], { settings: { disablePreHeating: false, disablePreCooling: true } }]);
  });

  it("does not invent a Smart Recovery control when the device omits its preference", async () => {
    (target.settings as Record<string, unknown>).disablePreCooling = undefined;
    expect(await invoke("set_smart_recovery", { cool_enabled: true })).toMatchObject({ ok: true, data: { supported: false, applied: false } });
    expect(manager.connectToReduxConnectionManager).not.toHaveBeenCalled();
  });

  it("maps a future demand-response preference to its fixed setting without cancelling events", async () => {
    const before = structuredClone(target.events);
    expect(await invoke("set_demand_response_preference", { preference: "never" })).toMatchObject({ ok: true, data: { delivery: "accepted", verification: "pending", settings: { drAccept: "askMe" } } });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("updateThermostatProperties", [[thermostatId], { settings: { drAccept: "never" } }]);
    expect(target.events).toEqual(before);
  });

  it("changes only whether an installer code is required and never changes the code itself", async () => {
    expect(await invoke("set_installer_code_required", { required: true })).toMatchObject({ ok: true, data: { delivery: "accepted", verification: "pending" } });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("updateThermostatProperties", [[thermostatId], { settings: { installerCodeRequired: true } }]);
    expect(await invoke("update_settings", { patch: { installerCodeRequired: true }, allow_advanced_settings: true })).toEqual({ ok: false, error: "invalid_input" });
  });

  it("does not replace the program with a schedule containing unknown references", async () => {
    const schedule = Array.from({ length: 7 }, () => Array(48).fill("missing"));
    expect(await invoke("set_schedule", { schedule })).toEqual({ ok: false, error: "invalid_input" });
    expect(manager.connectToReduxConnectionManager).not.toHaveBeenCalled();
  });

  it("preserves climates when replacing exactly seven days of half-hour cells", async () => {
    const schedule = Array.from({ length: 7 }, () => Array(48).fill("away"));
    expect(await invoke("set_schedule", { schedule })).toMatchObject({ ok: true });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("updateThermostatProperties", [[thermostatId], { program: { schedule, climates: target.program.climates } }]);
  });

  it("keeps current temperatures during a fan-only hold", async () => {
    expect(await invoke("set_fan", { mode: "on", hold_type: "next_transition" })).toMatchObject({ ok: true });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("setHold", [[thermostatId], { holdType: "nextTransition", fan: "on", coolHoldTemp: 760, heatHoldTemp: 680, isTemperatureAbsolute: false, isTemperatureRelative: false }]);
  });

  it("uses the same advertised capability gate and verified two-speed mapping for both fan-speed entry points", async () => {
    target.capabilities.fanCapabilities.speedOptions = ["LOW", "HIGH"];
    const result = await invoke("set_fan_speed", { speed: "high" });
    expect(result).toMatchObject({ ok: true, data: { delivery: "accepted", verification: "pending", requested_speed: "high", requested_wire_speed: "medium", reported_wire_speed: "optimized" } });
    expect(await invoke("update_settings", { patch: { fanSpeed: "high" } })).toMatchObject({ ok: true, data: { requested_wire_speed: "medium" } });
    expect(manager.connectToReduxConnectionManager).toHaveBeenNthCalledWith(1, "updateThermostatProperties", [[thermostatId], { settings: { fanSpeed: "medium" } }]);
    expect(manager.connectToReduxConnectionManager).toHaveBeenNthCalledWith(2, "updateThermostatProperties", [[thermostatId], { settings: { fanSpeed: "medium" } }]);
    expect(manager.getThermostats.mock.calls[0][0].selection.includeCapabilities).toBe(true);
    expect(await invoke("set_fan_speed", { speed: "medium_high" })).toMatchObject({ ok: true, data: { supported: false, applied: false } });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledTimes(2);
  });

  it("does not assume unsupported fan speeds or use a universal high-to-medium mapping", async () => {
    expect(await invoke("set_fan_speed", { speed: "high" })).toMatchObject({ ok: true, data: { requested_wire_speed: "high" } });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("updateThermostatProperties", [[thermostatId], { settings: { fanSpeed: "high" } }]);
    (target.capabilities as Record<string, unknown>).fanCapabilities = undefined;
    expect(await invoke("update_settings", { patch: { fanSpeed: "low" } })).toMatchObject({ ok: true, data: { supported: false, applied: false } });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledOnce();
  });

  it("sets an explicit local end time without inventing a start or changing an omitted setpoint", async () => {
    expect(await invoke("set_temperature_until", { cool: 78, unit: "F", end_date: "2026-10-18", end_time: "08:00:00" })).toMatchObject({ ok: true, data: { delivery: "accepted" } });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("setHold", [[thermostatId], { holdType: "dateTime", heatHoldTemp: 680, coolHoldTemp: 780, isTemperatureAbsolute: true, isTemperatureRelative: false, endDate: "2026-10-18", endTime: "08:00:00" }]);
    expect(await invoke("set_temperature_until", { cool: 78, unit: "F", end_date: "2026-10-17", end_time: "13:59:59" })).toEqual({ ok: false, error: "invalid_input" });
    expect(await invoke("set_temperature_until", { cool: 78, unit: "F", start_date: "2026-10-17", end_date: "2026-10-18", end_time: "08:00:00" })).toEqual({ ok: false, error: "invalid_input" });
  });

  it("resumes all resumable events through the documented function without deleting vacation records", async () => {
    const before = structuredClone(target.events);
    expect(await invoke("resume_all_events")).toMatchObject({ ok: true, data: { delivery: "accepted", verification: "not_verified" } });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("updateThermostat", [[thermostatId], undefined, [{ type: "resumeProgram", params: { resumeAll: true } }]]);
    expect(target.events).toEqual(before);
    (target.events as Record<string, unknown>[]).push({ type: "demandResponse", running: true, isOptional: false });
    expect(await invoke("resume_all_events")).toEqual({ ok: false, error: "demand_response" });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledOnce();
  });

  it("writes only verified audio fields exposed by this thermostat", async () => {
    expect(await invoke("update_audio", { patch: { playbackVolume: 25, microphoneEnabled: true } })).toMatchObject({ ok: true, data: { delivery: "accepted", verification: "pending", audio: { playbackVolume: 50, microphoneEnabled: false } } });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("updateThermostatProperties", [[thermostatId], { audio: { playbackVolume: 25, microphoneEnabled: true } }]);
    expect(await invoke("update_audio", { patch: { voiceEngines: [] } })).toEqual({ ok: false, error: "invalid_input" });
    expect(await invoke("update_audio", { patch: { playbackVolume: 101 } })).toEqual({ ok: false, error: "invalid_input" });
  });

  it("updates timezone preferences without reposting the thermostat's address or offset", async () => {
    const result = await invoke("set_timezone", { time_zone: "America/New_York", is_daylight_saving: false });
    expect(result).toMatchObject({ ok: true, data: { delivery: "accepted", verification: "pending", location: { timeZone: "America/Chicago", isDaylightSaving: true } } });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("updateThermostatProperties", [[thermostatId], { location: { timeZone: "America/New_York", isDaylightSaving: false } }]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(await invoke("set_timezone", { time_zone: "Invalid/Timezone" })).toEqual({ ok: false, error: "invalid_input" });
  });

  it("allows documented basic settings but requires explicit advanced intent", async () => {
    expect(await invoke("update_settings", { patch: { backlightOnIntensity: 7 } })).toMatchObject({ ok: true });
    expect(await invoke("update_settings", { patch: { tempCorrection: 5 } })).toEqual({ ok: false, error: "invalid_input" });
    expect(await invoke("update_settings", { patch: { tempCorrection: 5 }, allow_advanced_settings: true })).toMatchObject({ ok: true });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledTimes(2);
  });

  it("accepts a catalog-approved value for every documented writable setting without allowlist drift", async () => {
    const candidates: unknown[] = [false, true, 0, 1, 5, 10, 50, 100, 300, 600, "en", "auto", "on", "off", "indefinite", "50", "low", "2026-10-17"];
    for (const key of writableSettingsKeys) {
      let approved: ReturnType<typeof parseFeatureRequest> | undefined;
      for (const value of candidates) {
        try {
          approved = parseFeatureRequest({ name: "update_settings", input: { thermostat_id: thermostatId, patch: { [key]: value }, allow_advanced_settings: advancedSettingsKeys.includes(key as typeof advancedSettingsKeys[number]) } });
          break;
        } catch { /* Choose a representative value admitted by this field's catalog schema. */ }
      }
      expect(approved, `representative schema value for ${key}`).toBeDefined();
      target = makeThermostat();
      Object.assign(target.settings, { heatRangeLow: -400, heatRangeHigh: 2200, coolRangeLow: -400, coolRangeHigh: 2200, coldTempAlert: -400, hotTempAlert: 2200, humidityLowAlert: 0, humidityHighAlert: 100 });
      const patch = approved!.input.patch as Record<string, unknown>;
      (target.settings as Record<string, unknown>)[key] = patch[key];
      expect(await runFeatureOperation(approved!), `page accepts catalog-approved ${key}`).toMatchObject({ ok: true, data: { delivery: "accepted" } });
    }
  });

  it("rejects hardware, credential and arbitrary settings keys", async () => {
    for (const patch of [{ userAccessCode: "1234" }, { arbitrary: true }, { token: "PRIVATE" }, { heatStages: 5 }]) {
      expect(await invoke("update_settings", { patch, allow_advanced_settings: true })).toEqual({ ok: false, error: "invalid_input" });
    }
    expect(manager.connectToReduxConnectionManager).not.toHaveBeenCalled();
  });

  it("creates a vacation using verified API field names and thermostat-local times", async () => {
    expect(await invoke("create_vacation", { name: "Trip", heat: 62, cool: 82, unit: "F", start_date: "2026-11-01", start_time: "09:00:00", end_date: "2026-11-03", end_time: "17:00:00", fan: "auto", fan_min_on_time: 5 })).toMatchObject({ ok: true });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("createVacation", [[thermostatId], { name: "Trip", heatHoldTemp: 620, coolHoldTemp: 820, startDate: "2026-11-01", startTime: "09:00:00", endDate: "2026-11-03", endTime: "17:00:00", fanMinOnTime: 5, isHeatOff: false, isCoolOff: false, fan: "auto" }]);
  });

  it("deletes only an existing vacation identified by exact name", async () => {
    expect(await invoke("delete_vacation", { name: "missing" })).toEqual({ ok: false, error: "invalid_input" });
    expect(await invoke("delete_vacation", { name: "Holiday" })).toMatchObject({ ok: true });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("deleteVacation", [[thermostatId], "Holiday"]);
  });

  it("uses the source-verified device and capability IDs to rename a sensor", async () => {
    expect(await invoke("rename_sensor", { sensor_id: "rs:100", name: "Bedroom East" })).toMatchObject({ ok: true });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("renameSensor", [[thermostatId], "rs:100", "1", "Bedroom East"]);
  });

  it("resolves existing compound sensor references and rejects guessed capability suffixes", async () => {
    expect(await invoke("get_sensors")).toMatchObject({ ok: true, data: { sensors: [{ id: "rs:100", climateSensorRef: "rs:100:1" }] } });
    expect(await invoke("update_comfort_setting", { climate_ref: "home", unit: "F", sensor_ids: ["rs:100:9"] })).toEqual({ ok: false, error: "invalid_input" });
    expect(await invoke("update_comfort_setting", { climate_ref: "home", unit: "F", sensor_ids: ["rs:100:1"] })).toMatchObject({ ok: true });
    expect(await invoke("rename_sensor", { sensor_id: "rs:100:1", name: "East" })).toMatchObject({ ok: true });
    expect(manager.connectToReduxConnectionManager).toHaveBeenLastCalledWith("renameSensor", [[thermostatId], "rs:100", "1", "East"]);
  });

  it("does not acknowledge an alert outside the fresh thermostat response", async () => {
    expect(await invoke("acknowledge_alert", { ack_ref: "missing", ack_type: "accept" })).toEqual({ ok: false, error: "invalid_input" });
    expect(await invoke("acknowledge_alert", { ack_ref: "ack-1", ack_type: "defer", remind_me_later: true })).toMatchObject({ ok: true });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("acknowledgeAlert", [[thermostatId], "ack-1", "defer", true]);
  });

  it("normalizes a numeric server acknowledgement reference without guessing identifiers", async () => {
    (target.alerts[0] as Record<string, unknown>).acknowledgeRef = 12345;
    expect(await invoke("get_alerts")).toMatchObject({ ok: true, data: { alerts: [{ acknowledgeRef: "12345" }] } });
    expect(await invoke("acknowledge_alert", { ack_ref: "12345", ack_type: "accept" })).toMatchObject({ ok: true });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("acknowledgeAlert", [[thermostatId], "12345", "accept", false]);
  });

  it("maps a thermostat display message to the documented fixed API function", async () => {
    expect(await invoke("send_message", { text: "Please replace the filter." })).toMatchObject({ ok: true });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("updateThermostat", [[thermostatId], undefined, [{ type: "sendMessage", params: { text: "Please replace the filter." } }]]);
  });

  it("keeps household writes separate from location/account writes", async () => {
    expect(await invoke("update_house_details", { patch: { streetAddress: "PRIVATE" } })).toEqual({ ok: false, error: "invalid_input" });
    expect(await invoke("update_house_details", { patch: { size: 2200, windowEfficiency: 4 } })).toMatchObject({ ok: true });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("updateThermostatProperties", [[thermostatId], { houseDetails: { size: 2200, windowEfficiency: 4 } }]);
  });

  it("requires an explicit true reset flag before dispatching the fixed reset action", async () => {
    expect(await invoke("reset_preferences", {})).toEqual({ ok: false, error: "invalid_input" });
    expect(await invoke("reset_preferences", { confirm_reset: false })).toEqual({ ok: false, error: "invalid_input" });
    expect(manager.connectToReduxConnectionManager).not.toHaveBeenCalled();
    expect(await invoke("reset_preferences", { confirm_reset: true })).toMatchObject({ ok: true, data: { delivery: "accepted", verification: "not_verified" } });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("resetPreferences", [[thermostatId]]);
  });

  it("preserves the entire group collection, membership and unpatched flags", async () => {
    const flags = Object.fromEntries(["synchronizeAlerts", "synchronizeSystemMode", "synchronizeSchedule", "synchronizeQuickSave", "synchronizeReminders", "synchronizeContractorInfo", "synchronizeUserPreferences", "synchronizeUtilityInfo", "synchronizeLocation", "synchronizeReset", "synchronizeVacation"].map(key => [key, true]));
    const groups = [{ groupRef: "g1", groupName: "Downstairs", thermostats: [thermostatId], ...flags }, { groupRef: "g2", groupName: "Upstairs", thermostats: [thermostatId], ...flags }];
    manager.getGroups.mockResolvedValue({ status: { code: 0 }, groups });
    expect(await invoke("update_group", { group_ref: "g1", patch: { groupName: "Main floor", synchronizeSchedule: false } })).toMatchObject({ ok: true });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("updateGroups", [[{ ...groups[0], groupName: "Main floor", synchronizeSchedule: false }, groups[1]]]);
    expect(groups[0].groupName).toBe("Downstairs");
    expect(groups[0].synchronizeSchedule).toBe(true);
  });

  it("does not repost a group collection with any unowned member or missing flags", async () => {
    manager.getGroups.mockResolvedValue({ status: { code: 0 }, groups: [{ groupRef: "g1", thermostats: ["999999999999"] }] });
    expect(await invoke("update_group", { group_ref: "g1", patch: { groupName: "Changed" } })).toEqual({ ok: false, error: "invalid_input" });
    manager.getGroups.mockResolvedValue({ status: { code: 0 }, groups: [{ groupRef: "g1", thermostats: [thermostatId] }] });
    expect(await invoke("update_group", { group_ref: "g1", patch: { groupName: "Changed" } })).toMatchObject({ ok: true, data: { supported: false, applied: false } });
    expect(manager.connectToReduxConnectionManager).not.toHaveBeenCalled();
  });

  it("creates a group without guessing its reference and reads back the generated value", async () => {
    manager.getGroups.mockResolvedValueOnce({ status: { code: 0 }, groups: [] }).mockResolvedValueOnce({ status: { code: 0 }, groups: [{ groupName: "New group", groupRef: "generated-group", thermostats: [thermostatId] }] });
    expect(await invoke("create_group", { name: "New group", thermostat_ids: [thermostatId] })).toMatchObject({ ok: true, data: { delivery: "accepted", verification: "observed", verification_scope: "created_reference", group_ref: "generated-group" } });
    const sent = manager.connectToReduxConnectionManager.mock.calls[0];
    expect(sent[0]).toBe("updateGroups");
    expect(sent[1][0][0]).toMatchObject({ groupName: "New group", thermostats: [thermostatId], synchronizeSchedule: false, synchronizeReset: false });
    expect(sent[1][0][0]).not.toHaveProperty("groupRef");
  });

  it("deletes the last group using the portal's explicit empty-members representation", async () => {
    const flags = Object.fromEntries(["synchronizeAlerts", "synchronizeSystemMode", "synchronizeSchedule", "synchronizeQuickSave", "synchronizeReminders", "synchronizeContractorInfo", "synchronizeUserPreferences", "synchronizeUtilityInfo", "synchronizeLocation", "synchronizeReset", "synchronizeVacation"].map(key => [key, false]));
    const group = { groupRef: "g1", groupName: "Group", thermostats: [thermostatId], ...flags };
    manager.getGroups.mockResolvedValue({ status: { code: 0 }, groups: [group] });
    expect(await invoke("delete_group", { group_ref: "g1" })).toEqual({ ok: false, error: "invalid_input" });
    expect(await invoke("delete_group", { group_ref: "g1", confirm_delete: true })).toMatchObject({ ok: true });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("updateGroups", [[{ ...group, thermostats: [] }]]);
    expect(group.thermostats).toEqual([thermostatId]);
  });

  it("requires an existing group anchor and refuses implicit moves from another group", async () => {
    const otherId = "111111111111";
    manager.getThermostats.mockResolvedValue({ status: { code: 0 }, thermostatList: [target, { ...target, identifier: otherId }] });
    const flags = Object.fromEntries(["synchronizeAlerts", "synchronizeSystemMode", "synchronizeSchedule", "synchronizeQuickSave", "synchronizeReminders", "synchronizeContractorInfo", "synchronizeUserPreferences", "synchronizeUtilityInfo", "synchronizeLocation", "synchronizeReset", "synchronizeVacation"].map(key => [key, false]));
    manager.getGroups.mockResolvedValue({ status: { code: 0 }, groups: [{ groupRef: "g1", groupName: "One", thermostats: [thermostatId], ...flags }, { groupRef: "g2", groupName: "Two", thermostats: [otherId], ...flags }] });
    expect(await invoke("update_group", { group_ref: "g2", patch: { groupName: "Changed" } })).toEqual({ ok: false, error: "invalid_input" });
    expect(await invoke("update_group", { group_ref: "g1", thermostat_ids: [thermostatId, otherId] })).toEqual({ ok: false, error: "invalid_input" });
    expect(await invoke("create_group", { name: "Third", thermostat_ids: [thermostatId] })).toEqual({ ok: false, error: "invalid_input" });
    expect(manager.connectToReduxConnectionManager).not.toHaveBeenCalled();
  });

  it("reads notification preferences without exposing recipient email addresses", async () => {
    const result = await invoke("get_notification_settings");
    expect(result).toMatchObject({ ok: true, data: { notification_settings: { emailNotificationsEnabled: true } } });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|emailAddresses/);
    expect(manager.connectToReduxConnectionManager).not.toHaveBeenCalled();
  });

  it("sends only changed reminder types and fields, preserving unrequested notification arrays", async () => {
    const before = structuredClone(target.notificationSettings);
    expect(await invoke("update_notification_settings", { patch: { equipment: [{ type: "furnaceFilter", filterLife: 3, filterLifeUnits: "month", filterLastChanged: "2026-10-17" }] } })).toMatchObject({ ok: true });
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledExactlyOnceWith("updateThermostatProperties", [[thermostatId], { notificationSettings: { equipment: [{ type: "furnaceFilter", filterLife: 3, filterLifeUnits: "month", filterLastChanged: "2026-10-17" }] } }]);
    expect(target.notificationSettings).toEqual(before);
  });

  it("does not invent equipment types, replace recipient addresses or write computed reminder dates", async () => {
    expect(await invoke("update_notification_settings", { patch: { equipment: [{ type: "unknownFilter", enabled: true }] } })).toMatchObject({ ok: true, data: { supported: false, applied: false } });
    expect(await invoke("update_notification_settings", { patch: { emailAddresses: ["a@example.com"] } })).toEqual({ ok: false, error: "invalid_input" });
    expect(await invoke("update_notification_settings", { patch: { equipment: [{ type: "furnaceFilter", remindMeDate: "2027-01-01" }] } })).toEqual({ ok: false, error: "invalid_input" });
    expect(manager.connectToReduxConnectionManager).not.toHaveBeenCalled();
  });

  it("rejects a single limit update that would silently move an existing counterpart", async () => {
    expect(await invoke("update_notification_settings", { patch: { limit: [{ type: "lowTemp", limit: 880 }] } })).toEqual({ ok: false, error: "invalid_input" });
    expect(await invoke("update_notification_settings", { patch: { limit: [{ type: "lowHumidity", limit: 68 }] } })).toEqual({ ok: false, error: "invalid_input" });
    expect(manager.connectToReduxConnectionManager).not.toHaveBeenCalled();
    expect(await invoke("update_notification_settings", { patch: { limit: [{ type: "lowTemp", limit: 600 }] } })).toMatchObject({ ok: true });
  });

  it("reads groups only after account ownership verification", async () => {
    expect(await invoke("get_groups")).toMatchObject({ ok: true, data: { groups: [{ groupRef: "group-1" }] } });
    expect(manager.getGroups).toHaveBeenCalledOnce();
    expect(manager.getThermostats).toHaveBeenCalledOnce();
  });

  it("returns explicit unsupported capability when the portal has no report method", async () => {
    (manager as Record<string, unknown>).getThermostatRuntime = undefined;
    expect(await invoke("get_runtime_report", { start_date: "2026-10-16", end_date: "2026-10-17" })).toMatchObject({ ok: true, data: { supported: false, applied: false } });
  });

  it("honors selected report columns using the portal's verified fixed CSV column order", async () => {
    const browser = window as Window & { moment?: unknown };
    browser.moment = { utc: (date: string) => ({ isValid: () => true, utc: () => ({ format: () => date }) }) };
    const result = await invoke("get_runtime_report", { start_date: "2026-10-16", end_date: "2026-10-17", columns: ["zoneHvacMode"] });
    expect(result).toMatchObject({ ok: true, data: { reportList: [{ columns: ["date", "time", "zoneHvacMode"], rowList: [["2026-10-17", "00:00:00", "auto"]] }] } });
    expect(manager.getThermostatRuntime).toHaveBeenCalledOnce();
  });

  it("rejects report columns the verified portal does not request", async () => {
    const browser = window as Window & { moment?: unknown };
    browser.moment = { utc: () => ({ isValid: () => true }) };
    expect(await invoke("get_runtime_report", { start_date: "2026-10-16", end_date: "2026-10-17", columns: ["arbitrarySecret"] })).toEqual({ ok: false, error: "invalid_input" });
    expect(manager.getThermostatRuntime).not.toHaveBeenCalled();
  });

  it("checks same-day report interval ordering and returns the requested window metadata", async () => {
    const browser = window as Window & { moment?: unknown };
    browser.moment = { utc: (date: string) => ({ isValid: () => true, utc: () => ({ format: () => date }) }) };
    expect(await invoke("get_runtime_report", { start_date: "2026-10-17", end_date: "2026-10-17", start_interval: 100, end_interval: 10 })).toEqual({ ok: false, error: "invalid_input" });
    expect(await invoke("get_runtime_report", { start_date: "2026-10-17", end_date: "2026-10-17", start_interval: 10, end_interval: 20, columns: ["zoneHvacMode"] })).toMatchObject({ ok: true, data: { start_date: "2026-10-17", end_date: "2026-10-17", start_interval: 10, end_interval: 20 } });
    expect(manager.getThermostatRuntime).toHaveBeenCalledWith([thermostatId], expect.anything(), expect.anything(), 10, 20);
  });

  it("never retries an ambiguous write or exposes the underlying browser exception", async () => {
    manager.connectToReduxConnectionManager.mockRejectedValue(new Error("PRIVATE SESSION URL TOKEN"));
    const result = await invoke("set_fan", { mode: "on", hold_type: "indefinite" });
    expect(result).toMatchObject({ ok: false, error: "write_uncertain" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(manager.connectToReduxConnectionManager).toHaveBeenCalledOnce();
  });

  it("fails a nonzero status before any write", async () => {
    manager.getThermostats.mockResolvedValue({ status: { code: 14 }, thermostatList: [] });
    expect(await invoke("set_fan", { mode: "on", hold_type: "indefinite" })).toEqual({ ok: false, error: "login_required", diagnostics: { phase: "read", apiCode: 14 } });
    expect(manager.connectToReduxConnectionManager).not.toHaveBeenCalled();
  });

  it("bounds oversized nested read data and labels truncation", async () => {
    (target.runtime as Record<string, unknown>).samples = Array.from({ length: 1000 }, () => "x".repeat(2000));
    const result = await invoke("get_thermostat_details", { sections: ["runtime"] });
    expect(result).toMatchObject({ ok: true, data: { truncated: true } });
    expect(JSON.stringify(result).length).toBeLessThan(100000);
  });
});
