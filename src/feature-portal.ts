import type { FeatureRequest } from "./feature-types.js";
import type { PortalDiagnostics, PortalErrorCode } from "./portal.js";

export type FeaturePortalResult = { ok: true; data: unknown } | { ok: false; error: PortalErrorCode; diagnostics?: PortalDiagnostics };

/** Serialized browser function: all runtime helpers deliberately live inside it.
 * Portal method signatures/actions were inspected in the public
 * consumerportal/scripts/ecobee.components.7d351bac.js bundle on 2026-10-17.
 * SendMessage: https://www.ecobee.com/home/developer/api/documentation/v1/functions/SendMessage.shtml
 * Energy master writes follow cmdSetECO in the maintained UDI cloud backend:
 * https://github.com/UniversalDevicesInc-PG3/udi-poly-ecobee/blob/master/nodes/backends/cloud/Thermostat.py
 * individual eco+ feature writes are intentionally not inferred from that.
 */
export async function runFeatureOperation(request: FeatureRequest): Promise<FeaturePortalResult> {
  type Obj = Record<string, unknown>;
  type Manager = {
    getThermostats(selection: Obj): PromiseLike<unknown>;
    connectToReduxConnectionManager(action: string, args: unknown[]): PromiseLike<unknown>;
    getGroups?(): PromiseLike<unknown>;
    getThermostatRuntime?(ids: string[], start: unknown, end: unknown, startInterval?: number, endInterval?: number): PromiseLike<unknown>;
  };
  const object = (value: unknown): Obj | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : undefined;
  const finite = (value: unknown, low = -1_000_000, high = 1_000_000): value is number => typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
  const text = (value: unknown, limit = 120): string => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, limit) : "";
  const scalar = (value: unknown): boolean => typeof value === "boolean" || typeof value === "string" || finite(value);
  const forbidden = /token|password|secret|cookie|authorization|access.?code|access.?setting|installer.?code|pin$|pin.?code|credential|security|privacy|serial|street|postal|email|phone|coordinates|latitude|longitude|user.?name|user.?id|account/i;
  let writeStarted = false;
  let requestedFanSpeed: string | undefined;
  let truncated = false;
  let remaining = 4000;
  let characters = 60000;
  const clean = (value: unknown, depth = 0): unknown => {
    if (--remaining < 0 || depth > 8) { truncated = true; return null; }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") {
      const maximum = Math.max(0, Math.min(1200, characters));
      if (value.length > maximum) truncated = true;
      characters -= Math.min(value.length, maximum);
      let result = text(value, maximum).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted]");
      if (/^https?:\/\//i.test(result)) {
        try { const url = new URL(result); result = `${url.origin}${url.pathname}`; } catch { result = "[redacted]"; }
      }
      return result;
    }
    if (Array.isArray(value)) {
      if (value.length > 400) truncated = true;
      return value.slice(0, 400).map(item => clean(item, depth + 1));
    }
    const record = object(value);
    if (!record) return null;
    const result: Obj = {};
    const keys = Object.keys(record);
    if (keys.length > 150) truncated = true;
    for (const key of keys.slice(0, 150)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(key) || (forbidden.test(key) && !(["emailNotificationsEnabled", "installerCodeRequired"].includes(key) && typeof record[key] === "boolean"))) continue;
      if (characters < key.length) { truncated = true; break; }
      characters -= key.length;
      result[key] = clean(record[key], depth + 1);
    }
    return result;
  };
  const diagnostics = (value: unknown): PortalDiagnostics => {
    const record = object(value);
    const code = object(record?.status)?.code;
    const status = record?.status;
    return { phase: writeStarted ? "write" : "read",
      ...(finite(code, 0, 9999) && Number.isInteger(code) ? { apiCode: code } : {}),
      ...(finite(status, 100, 599) && Number.isInteger(status) ? { httpStatus: status } : {}),
    };
  };
  const fail = (error: PortalErrorCode, value?: unknown): FeaturePortalResult => ({ ok: false, error, ...(value === undefined ? {} : { diagnostics: diagnostics(value) }) });
  const success = (data: Obj): FeaturePortalResult => ({ ok: true, data: { ...data, truncated } });
  const unsupported = (name: string): FeaturePortalResult => success({ supported: false, applied: false, capability: name, reason: "This operation is not supported by the verified portal interface on this thermostat." });
  const call = async (start: () => PromiseLike<unknown>): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([Promise.resolve().then(start), new Promise<never>((_, reject) => { timer = setTimeout(() => reject("feature_timeout"), 25_000); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const checked = (value: unknown): FeaturePortalResult | null => {
    const record = object(value);
    const code = object(record?.status)?.code;
    if (code === 14 || record?.status === 401 || record?.status === 403 || record?.error === "invalid_token" || record?.error === "invalid_grant") return fail("login_required", value);
    if (typeof code !== "number" || !Number.isInteger(code)) return fail(writeStarted ? "write_uncertain" : "invalid_response", value);
    return code === 0 ? null : fail("request_failed", value);
  };
  try {
    if (location.protocol !== "https:" || !["www.ecobee.com", "ecobee.com"].includes(location.hostname) || !location.pathname.startsWith("/consumerportal/")) return fail("login_required");
    const input = object(request?.input);
    if (!input || typeof request?.name !== "string" || typeof input.thermostat_id !== "string" || !/^[0-9]{1,32}$/.test(input.thermostat_id)) return fail("invalid_input");
    const id = input.thermostat_id;
    const reads: Record<string, string[]> = {
      get_settings: ["settings"], get_comfort_settings: ["program"], get_schedule: ["program"], get_sensors: ["sensors"],
      get_weather: ["weather"], get_alerts: ["alerts"], get_events: ["events"], get_energy_status: ["energy", "runtime", "events", "program", "settings"],
      get_equipment_status: ["equipment_status", "settings", "runtime", "capabilities"], get_vacations: ["events"], get_extended_runtime: ["extended_runtime"],
      get_house_details: ["house_details"], get_utility_info: ["utility"], get_technician_info: ["technician"], get_groups: [], get_runtime_report: [], get_notification_settings: ["notification_settings"],
    };
    const writes = ["update_settings", "set_comfort_setting", "update_comfort_setting", "set_schedule", "set_fan", "create_vacation", "delete_vacation", "rename_sensor", "acknowledge_alert", "send_message", "update_house_details", "set_eco_plus", "set_smart_recovery", "set_demand_response_preference", "set_installer_code_required", "rename_thermostat", "create_comfort_setting", "delete_comfort_setting", "update_notification_settings", "reset_preferences", "update_group", "create_group", "delete_group", "set_temperature_until", "resume_all_events", "set_fan_speed", "update_audio", "set_timezone"];
    if (!Object.hasOwn(reads, request.name) && request.name !== "get_thermostat_details" && !writes.includes(request.name)) return fail("invalid_input");
    const flagMap: Record<string, string> = {
      runtime: "includeRuntime", settings: "includeSettings", events: "includeEvents", program: "includeProgram", sensors: "includeSensors",
      weather: "includeWeather", alerts: "includeAlerts", energy: "includeEnergy", equipment_status: "includeEquipmentStatus",
      extended_runtime: "includeExtendedRuntime", house_details: "includeHouseDetails", utility: "includeUtility", technician: "includeTechnician",
      devices: "includeDevice", location: "includeLocation", audio: "includeAudio", notification_settings: "includeNotificationSettings", capabilities: "includeCapabilities",
    };
    const writeSections: Record<string, string[]> = {
      update_settings: ["events"], set_comfort_setting: ["events", "program"], update_comfort_setting: ["events", "program", "sensors"],
      set_schedule: ["events", "program"], set_fan: ["events"], create_vacation: ["events"], delete_vacation: ["events"],
      rename_sensor: ["events", "sensors"], acknowledge_alert: ["events", "alerts"], send_message: ["events"], update_house_details: ["events"], set_eco_plus: ["events", "energy"], set_smart_recovery: ["events"], set_demand_response_preference: ["events"], set_installer_code_required: ["events"],
      rename_thermostat: ["events"], create_comfort_setting: ["events", "program", "sensors"], delete_comfort_setting: ["events", "program"], update_notification_settings: ["events", "notification_settings"], reset_preferences: ["events"], update_group: ["events"], create_group: ["events"], delete_group: ["events"],
      set_temperature_until: ["events"], resume_all_events: ["events"], set_fan_speed: ["events", "capabilities"], update_audio: ["events", "audio"], set_timezone: ["events", "location"],
    };
    let sections = reads[request.name] ?? writeSections[request.name] ?? ["runtime", "settings", "events"];
    if (request.name === "get_thermostat_details") {
      sections = Array.isArray(input.sections) ? input.sections as string[] : ["runtime", "settings", "events"];
      if (!sections.length || sections.length > 16 || sections.some(section => typeof section !== "string" || (!Object.hasOwn(flagMap, section) && section !== "electricity"))) return fail("invalid_input");
    }
    const angular = (window as Window & { angular?: { element(element: Element | Document): { injector(): { get(name: string): unknown } | undefined } } }).angular;
    if (!angular) return fail("site_changed");
    let manager: Manager | undefined;
    for (const element of [document.querySelector("[ng-app]"), document.body, document.documentElement, document]) {
      if (!element) continue;
      try { manager = angular.element(element).injector()?.get("connectionManagerAPI") as Manager; } catch { /* The next root may own Angular. */ }
      if (manager) break;
    }
    if (!manager || typeof manager.getThermostats !== "function" || typeof manager.connectToReduxConnectionManager !== "function") return fail("site_changed");
    const api = manager;
    const selection: Obj = { selectionType: "registered", includeRuntime: true, includeSettings: true };
    if (request.name === "update_settings" && object(input.patch)?.fanSpeed !== undefined) selection.includeCapabilities = true;
    // Electricity has no verified include flag in the public Selection schema;
    // report it unavailable rather than inventing an API field.
    for (const section of sections) if (Object.hasOwn(flagMap, section)) selection[flagMap[section]] = true;
    const response = await call(() => api.getThermostats({ selection }));
    const bad = checked(response);
    if (bad) return bad;
    const list = object(response)?.thermostatList;
    if (!Array.isArray(list) || list.length > 200 || list.some(value => typeof object(value)?.identifier !== "string" || !/^[0-9]{1,32}$/.test(object(value)!.identifier as string)) ||
        new Set(list.map(value => object(value)?.identifier)).size !== list.length) return fail("invalid_response");
    const target = list.map(object).find(value => value?.identifier === id);
    if (!target) return fail("thermostat_missing");
    const settings = object(target.settings) ?? {};
    const runtime = object(target.runtime) ?? {};
    const program = object(target.program);
    const events = Array.isArray(target.events) ? target.events.map(object).filter((value): value is Obj => Boolean(value)) : [];
    const sensors = Array.isArray(target.remoteSensors) ? target.remoteSensors.map(object).filter((value): value is Obj => Boolean(value)) : [];
    const capabilityId = (capability: unknown): string | undefined => {
      const value = object(capability)?.id;
      return typeof value === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(value) ? value : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
    };
    const temperatureReference = (sensor: Obj): string | undefined => {
      if (typeof sensor.id !== "string" || !Array.isArray(sensor.capability)) return undefined;
      const capability = sensor.capability.find(value => object(value)?.type === "temperature");
      const id = capabilityId(capability);
      // The portal's ClimateParser.parseFrontendSensors appends the temperature
      // capability ID to the remote sensor's device ID.
      return id === undefined ? undefined : `${sensor.id}:${id}`;
    };
    const findSensor = (reference: unknown): Obj | undefined => typeof reference === "string" ? sensors.find(sensor => sensor.id === reference ||
      (typeof sensor.id === "string" && Array.isArray(sensor.capability) && sensor.capability.some(value => {
        const id = capabilityId(value);
        return id !== undefined && `${sensor.id}:${id}` === reference;
      }))) : undefined;
    const energy = object(target.energy);
    const fanWireSpeed = (value: unknown): string | undefined => {
      const valid = ["low", "medium_low", "medium", "medium_high", "high", "optimized"];
      const options = object(object(target.capabilities)?.fanCapabilities)?.speedOptions;
      if (typeof value !== "string" || !valid.includes(value) || typeof settings.fanSpeed !== "string" || !Array.isArray(options) ||
          options.length > 6 || !options.every(option => typeof option === "string" && valid.includes(option.toLowerCase()) && option === option.toUpperCase()) ||
          !options.includes(value.toUpperCase())) return undefined;
      // Both maintained implementations verify this exact two-speed case:
      // advertised HIGH without MEDIUM uses the legacy "medium" wire setting.
      return value === "high" && !options.includes("MEDIUM") ? "medium" : value;
    };
    const name = text(target.name) || "Ecobee thermostat";
    const readSections = (): Obj => {
      const result: Obj = { thermostat_id: id, name, available_sections: [],
        temperatureUnits: "Ecobee canonical temperature fields are Fahrenheit multiplied by 10.",
        sensorValueUnits: { temperature: "numeric string, Fahrenheit multiplied by 10", humidity: "percent", occupancy: "boolean string" },
        thermostat_local_time: typeof target.thermostatTime === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(target.thermostatTime) ? target.thermostatTime : null };
      const available = result.available_sections as string[];
      const rawNames: Record<string, string> = { sensors: "remoteSensors", equipment_status: "equipmentStatus", extended_runtime: "extendedRuntime", house_details: "houseDetails", devices: "devices", notification_settings: "notificationSettings" };
      for (const section of sections) {
        const value = section === "sensors" ? sensors.map(sensor => ({ ...sensor, ...(temperatureReference(sensor) ? { climateSensorRef: temperatureReference(sensor) } : {}) })) : target[rawNames[section] ?? section];
        result[section] = value === undefined ? null : clean(section === "alerts" && Array.isArray(value) ? value.map(alert => {
          const entry = object(alert);
          const reference = entry?.acknowledgeRef;
          return entry ? { ...entry, ...(typeof reference === "number" && Number.isSafeInteger(reference) && reference >= 0 ? { acknowledgeRef: String(reference) } : {}) } : null;
        }) : value);
        if (value !== undefined) available.push(section);
      }
      if (sections.includes("electricity") && target.electricity === undefined) result.unavailable_sections = ["electricity"];
      return result;
    };
    if (request.name === "get_energy_status") {
      const state = typeof energy?.energyFeatureState === "string" ? text(energy.energyFeatureState, 40) : null;
      return success({ thermostat_id: id, name, energy: energy ? clean(energy) : null,
        energyFeatureState: state, masterWriteSupported: state === "enabled" || state === "disabled",
        featureStateMeaning: "Values are reported verbatim; unverified per-feature enum meanings are not inferred.",
        displayedTemperatureF: finite(runtime.actualTemperature, -1000, 2000) ? runtime.actualTemperature / 10 : null,
        dryBulbTemperatureF: finite(runtime.rawTemperature, -1000, 2000) ? runtime.rawTemperature / 10 : null,
        runningEvents: clean(events.filter(event => event.running === true)), program: program ? clean(program) : null,
        programTemperatureUnits: "Fahrenheit multiplied by 10; fields explicitly ending F are already converted Fahrenheit.",
        automation: clean({ autoAway: settings.autoAway ?? null, followMeComfort: settings.followMeComfort ?? null, smartCirculation: settings.smartCirculation ?? null }),
      });
    }
    if (request.name === "get_groups") {
      if (typeof api.getGroups !== "function") return unsupported(request.name);
      const groups = await call(() => api.getGroups!());
      const invalid = checked(groups); if (invalid) return invalid;
      return success({ thermostat_id: id, groups: clean(object(groups)?.groups ?? null) });
    }
    if (request.name === "get_runtime_report") {
      if (typeof api.getThermostatRuntime !== "function") return unsupported(request.name);
      const startDate = input.start_date, endDate = input.end_date;
      if (typeof startDate !== "string" || typeof endDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return fail("invalid_input");
      const span = (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000;
      if (!Number.isFinite(span) || span < 0 || span > 30) return fail("invalid_input");
      const moment = (window as Window & { moment?: { utc(value: string, format: string, strict: boolean): { isValid(): boolean; utc(): unknown } } }).moment;
      if (typeof moment?.utc !== "function") return unsupported(request.name);
      const start = moment.utc(startDate, "YYYY-MM-DD", true), end = moment.utc(endDate, "YYYY-MM-DD", true);
      if (!start.isValid() || !end.isValid()) return fail("invalid_input");
      const first = input.start_interval ?? 0, last = input.end_interval ?? 287;
      if (!finite(first, 0, 287) || !Number.isInteger(first) || !finite(last, 0, 287) || !Number.isInteger(last) || (startDate === endDate && first > last)) return fail("invalid_input");
      const columns = ["date", "time", "zoneHvacMode", "zoneCalendarEvent", "zoneCoolTemp", "zoneHeatTemp", "zoneAveTemp", "zoneHumidity", "outdoorTemp", "outdoorHumidity", "compCool1", "compCool2", "compHeat1", "compHeat2", "auxHeat1", "auxHeat2", "auxHeat3", "fan", "humidifier", "dehumidifier", "economizer", "ventilator", "hvacMode", "zoneClimate"];
      if (input.columns !== undefined && (!Array.isArray(input.columns) || !input.columns.length || input.columns.length > 32 || new Set(input.columns).size !== input.columns.length || input.columns.some(column => typeof column !== "string" || !columns.includes(column)))) return fail("invalid_input");
      const selected = input.columns === undefined ? columns : ["date", "time", ...(input.columns as string[]).filter(column => column !== "date" && column !== "time")];
      const report = await call(() => api.getThermostatRuntime!([id], start, end, first, last));
      const invalid = checked(report); if (invalid) return invalid;
      const reports = object(report)?.reportList;
      if (Array.isArray(reports) && reports.length > 25) truncated = true;
      const reportList = Array.isArray(reports) ? reports.slice(0, 25).map(item => {
        const rows = object(item)?.rowList;
        if (Array.isArray(rows) && rows.length > 400) truncated = true;
        return { columns: selected, rowList: Array.isArray(rows) ? rows.slice(0, 400).map(row => typeof row === "string" ? selected.map(column => row.split(",")[columns.indexOf(column)] ?? null) : null) : null };
      }) : null;
      return success({ thermostat_id: id, start_date: startDate, end_date: endDate, start_interval: first, end_interval: last,
        temperatureUnits: "Fahrenheit (report CSV values are not tenths)",
        reportList: clean(reportList), sensorList: clean(object(report)?.sensorList ?? null) });
    }
    if (request.name === "get_vacations") return success({ thermostat_id: id, vacations: clean(events.filter(event => event.type === "vacation")) });
    if (!writes.includes(request.name)) return success(readSections());
    if (runtime.connected !== true) return fail("offline");
    if (!["rename_sensor", "acknowledge_alert", "send_message", "update_house_details", "set_demand_response_preference", "set_installer_code_required", "rename_thermostat", "update_notification_settings", "resume_all_events", "update_audio", "set_timezone"].includes(request.name) && events.some(event => event.type === "demandResponse" && event.running === true)) return fail("demand_response");
    if (request.name === "resume_all_events" && events.some(event => event.type === "demandResponse" && event.running === true && event.isOptional !== true)) return fail("demand_response");

    const ids = [id];
    const duration = (): Obj | undefined => {
      if (!["hours", "indefinite", "next_transition"].includes(input.hold_type as string)) return undefined;
      if (input.hold_type === "hours") return finite(input.hours, 1, 24) && Number.isInteger(input.hours) ? { holdType: "holdHours", holdHours: input.hours } : undefined;
      if (input.hours !== undefined) return undefined;
      return { holdType: input.hold_type === "indefinite" ? "indefinite" : "nextTransition" };
    };
    const canonical = (value: unknown): number | undefined => {
      if (!finite(value, -100, 220) || (input.unit !== "F" && input.unit !== "C")) return undefined;
      const result = Math.round((input.unit === "C" ? value * 9 / 5 + 32 : value) * 10);
      return finite(result, -400, 2200) ? result : undefined;
    };
    const temperaturesValid = (heat: unknown, cool: unknown): boolean => finite(heat, -400, 2200) && finite(cool, -400, 2200) &&
      finite(settings.heatRangeLow, -400, 2200) && finite(settings.heatRangeHigh, -400, 2200) && finite(settings.coolRangeLow, -400, 2200) && finite(settings.coolRangeHigh, -400, 2200) &&
      heat >= settings.heatRangeLow && heat <= settings.heatRangeHigh && cool >= settings.coolRangeLow && cool <= settings.coolRangeHigh &&
      (settings.hvacMode !== "auto" || (finite(settings.heatCoolMinDelta, 0, 500) && cool - heat >= settings.heatCoolMinDelta));
    let action: "updateThermostatProperties" | "setHold" | "createVacation" | "deleteVacation" | "renameSensor" | "acknowledgeAlert" | "updateThermostat" | "resetPreferences" | "updateGroups";
    let args: unknown[];
    switch (request.name) {
      case "set_temperature_until": {
        if (input.heat === undefined && input.cool === undefined) return fail("invalid_input");
        const heat = input.heat === undefined ? runtime.desiredHeat : canonical(input.heat), cool = input.cool === undefined ? runtime.desiredCool : canonical(input.cool);
        if (!temperaturesValid(heat, cool)) return fail("temperature_range");
        const date = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
        const time = (value: unknown) => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value);
        const hasStart = input.start_date !== undefined || input.start_time !== undefined;
        if ((hasStart && (!date(input.start_date) || !time(input.start_time))) || !date(input.end_date) || !time(input.end_time) ||
            (hasStart && `${input.start_date} ${input.start_time}` >= `${input.end_date} ${input.end_time}`)) return fail("invalid_input");
        const clock = target.thermostatTime;
        if (typeof clock === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(clock) && `${input.end_date} ${input.end_time}` <= clock) return fail("invalid_input");
        action = "setHold"; args = [ids, { holdType: "dateTime", heatHoldTemp: heat, coolHoldTemp: cool, isTemperatureAbsolute: true, isTemperatureRelative: false,
          ...(hasStart ? { startDate: input.start_date, startTime: input.start_time } : {}), endDate: input.end_date, endTime: input.end_time }]; break;
      }
      case "resume_all_events":
        action = "updateThermostat"; args = [ids, undefined, [{ type: "resumeProgram", params: { resumeAll: true } }]]; break;
      case "set_fan_speed": {
        const wire = fanWireSpeed(input.speed);
        if (!wire) return unsupported(request.name);
        requestedFanSpeed = input.speed as string;
        action = "updateThermostatProperties"; args = [ids, { settings: { fanSpeed: wire } }]; break;
      }
      case "update_audio": {
        const current = object(target.audio), patch = object(input.patch);
        if (!current) return unsupported(request.name);
        if (!patch || !Object.keys(patch).length || Object.keys(patch).some(key => !["playbackVolume", "microphoneEnabled", "soundAlertVolume", "soundTickVolume"].includes(key))) return fail("invalid_input");
        for (const [key, value] of Object.entries(patch)) {
          if (!Object.hasOwn(current, key)) return unsupported(request.name);
          if (key === "microphoneEnabled" ? typeof value !== "boolean" : !finite(value, 0, key === "playbackVolume" ? 100 : 10) || !Number.isInteger(value)) return fail("invalid_input");
        }
        action = "updateThermostatProperties"; args = [ids, { audio: { ...patch } }]; break;
      }
      case "set_timezone": {
        const current = object(target.location);
        if (!current) return unsupported(request.name);
        if ((input.time_zone === undefined && input.is_daylight_saving === undefined) || (input.is_daylight_saving !== undefined && typeof input.is_daylight_saving !== "boolean")) return fail("invalid_input");
        if (input.time_zone !== undefined) {
          if (typeof input.time_zone !== "string" || input.time_zone.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\/-]*$/.test(input.time_zone)) return fail("invalid_input");
          try { new Intl.DateTimeFormat("en-US", { timeZone: input.time_zone }); } catch { return fail("invalid_input"); }
          if (typeof current.timeZone !== "string") return unsupported(request.name);
        }
        if (input.is_daylight_saving !== undefined && typeof current.isDaylightSaving !== "boolean") return unsupported(request.name);
        action = "updateThermostatProperties"; args = [ids, { location: {
          ...(input.time_zone === undefined ? {} : { timeZone: input.time_zone }),
          ...(input.is_daylight_saving === undefined ? {} : { isDaylightSaving: input.is_daylight_saving }),
        } }]; break;
      }
      case "reset_preferences":
        if (input.confirm_reset !== true) return fail("invalid_input");
        action = "resetPreferences"; args = [ids]; break;
      case "update_group":
      case "create_group":
      case "delete_group": {
        if (typeof api.getGroups !== "function") return unsupported(request.name);
        const flags = ["synchronizeAlerts", "synchronizeSystemMode", "synchronizeSchedule", "synchronizeQuickSave", "synchronizeReminders", "synchronizeContractorInfo", "synchronizeUserPreferences", "synchronizeUtilityInfo", "synchronizeLocation", "synchronizeReset", "synchronizeVacation"];
        const groupResponse = await call(() => api.getGroups!());
        const badGroups = checked(groupResponse); if (badGroups) return badGroups;
        const source = object(groupResponse)?.groups;
        if (!Array.isArray(source) || source.length > 200) return fail("invalid_response");
        const owned = new Set(list.map(value => object(value)?.identifier));
        let groups: Obj[] = [];
        const references = new Set<string>();
        for (const value of source) {
          const group = object(value);
          const reference = typeof group?.groupRef === "string" ? group.groupRef : typeof group?.groupRef === "number" && Number.isSafeInteger(group.groupRef) ? String(group.groupRef) : "";
          if (!group || !reference || references.has(reference) || !Array.isArray(group.thermostats) || !group.thermostats.length || group.thermostats.length > 200 ||
              group.thermostats.some(member => typeof member !== "string" || !owned.has(member)) || new Set(group.thermostats).size !== group.thermostats.length) return fail("invalid_input");
          if (flags.some(flag => typeof group[flag] !== "boolean")) return unsupported(request.name);
          references.add(reference);
          groups.push({ ...group, thermostats: [...group.thermostats] });
        }
        const members = input.thermostat_ids;
        if (members !== undefined && (!Array.isArray(members) || !members.length || members.length > 200 || new Set(members).size !== members.length ||
            members.some(member => typeof member !== "string" || !owned.has(member)) || !members.includes(id))) return fail("invalid_input");
        if (request.name === "create_group") {
          if (!Array.isArray(members) || typeof input.name !== "string" || !input.name.trim() || input.name.length > 32 || /[\u0000-\u001f\u007f]/.test(input.name) ||
              groups.some(group => typeof group.groupName === "string" && group.groupName.toLowerCase() === (input.name as string).toLowerCase()) ||
              groups.some(group => (group.thermostats as string[]).some(member => members.includes(member)))) return fail("invalid_input");
          const created: Obj = { groupName: input.name, thermostats: [...members] };
          for (const flag of flags) {
            if (input[flag] !== undefined && typeof input[flag] !== "boolean") return fail("invalid_input");
            created[flag] = input[flag] ?? false;
          }
          groups.push(created);
        } else {
          if (typeof input.group_ref !== "string" || !input.group_ref) return fail("invalid_input");
          const group = groups.find(value => String(value.groupRef) === input.group_ref);
          if (!group || !(group.thermostats as string[]).includes(id)) return fail("invalid_input");
          if (request.name === "delete_group") {
            if (input.confirm_delete !== true) return fail("invalid_input");
            groups = groups.length === 1 ? [{ ...group, thermostats: [] }] : groups.filter(value => value !== group);
          } else {
            const patch = input.patch === undefined ? {} : object(input.patch);
            if (!patch || (input.patch !== undefined && !Object.keys(patch).length) || (!Object.keys(patch).length && members === undefined) ||
                Object.keys(patch).some(key => key !== "groupName" && !flags.includes(key))) return fail("invalid_input");
            if (patch.groupName !== undefined && (typeof patch.groupName !== "string" || !patch.groupName.trim() || patch.groupName.length > 32 || /[\u0000-\u001f\u007f]/.test(patch.groupName))) return fail("invalid_input");
            if (flags.some(flag => patch[flag] !== undefined && typeof patch[flag] !== "boolean")) return fail("invalid_input");
            if (typeof patch.groupName === "string" && groups.some(other => other !== group && typeof other.groupName === "string" && other.groupName.toLowerCase() === (patch.groupName as string).toLowerCase())) return fail("invalid_input");
            if (Array.isArray(members)) {
              if (groups.some(other => other !== group && (other.thermostats as string[]).some(member => members.includes(member)))) return fail("invalid_input");
              group.thermostats = [...members];
            }
            Object.assign(group, patch);
          }
        }
        // GroupManager.save/delete in the public UI posts the full collection;
        // omitting an existing group could delete it. Preserve every other row,
        // complete member list, and unpatched synchronization flag.
        action = "updateGroups"; args = [groups]; break;
      }
      case "rename_thermostat":
        if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 20 || /[\u0000-\u001f\u007f]/.test(input.name)) return fail("invalid_input");
        action = "updateThermostatProperties"; args = [ids, { name: input.name }]; break;
      case "set_demand_response_preference": {
        if (!["always", "askMe", "customerSelect", "defaultAccept", "defaultDecline", "never"].includes(input.preference as string)) return fail("invalid_input");
        if (typeof settings.drAccept !== "string") return unsupported(request.name);
        action = "updateThermostatProperties"; args = [ids, { settings: { drAccept: input.preference } }]; break;
      }
      case "set_installer_code_required": {
        if (typeof input.required !== "boolean") return fail("invalid_input");
        if (typeof settings.installerCodeRequired !== "boolean") return unsupported(request.name);
        action = "updateThermostatProperties"; args = [ids, { settings: { installerCodeRequired: input.required } }]; break;
      }
      case "set_smart_recovery": {
        if ((input.heat_enabled === undefined && input.cool_enabled === undefined) ||
            (input.heat_enabled !== undefined && typeof input.heat_enabled !== "boolean") ||
            (input.cool_enabled !== undefined && typeof input.cool_enabled !== "boolean")) return fail("invalid_input");
        if ((input.heat_enabled !== undefined && typeof settings.disablePreHeating !== "boolean") ||
            (input.cool_enabled !== undefined && typeof settings.disablePreCooling !== "boolean")) return unsupported(request.name);
        // Public portal Preferences UI explicitly maps false -> enabled and
        // true -> disabled for these negative-named API properties.
        action = "updateThermostatProperties"; args = [ids, { settings: {
          ...(input.heat_enabled === undefined ? {} : { disablePreHeating: !input.heat_enabled }),
          ...(input.cool_enabled === undefined ? {} : { disablePreCooling: !input.cool_enabled }),
        } }]; break;
      }
      case "set_eco_plus": {
        if (typeof input.enabled !== "boolean") return fail("invalid_input");
        if (energy?.energyFeatureState !== "enabled" && energy?.energyFeatureState !== "disabled") return unsupported(request.name);
        action = "updateThermostatProperties"; args = [ids, { energy: { energyFeatureState: input.enabled ? "enabled" : "disabled" } }]; break;
      }
      case "update_settings": {
        const originalPatch = object(input.patch);
        if (!originalPatch || Object.keys(originalPatch).length < 1 || Object.keys(originalPatch).length > 150) return fail("invalid_input");
        const patch = { ...originalPatch };
        const allowed = ["hvacMode", "fanMinOnTime", "holdAction", "useCelsius", "useTimeFormat12", "locale", "autoAway", "followMeComfort", "smartCirculation", "humidity", "humidifierMode", "dehumidifierMode", "dehumidifierLevel", "condensationAvoid", "dehumidifyWithAC", "dehumidifyOvercoolOffset", "vent", "ventilatorMinOnTime", "ventilatorMinOnTimeHome", "ventilatorMinOnTimeAway", "backlightOnIntensity", "backlightSleepIntensity", "backlightOffTime", "backlightOffDuringSleep", "coldTempAlert", "hotTempAlert", "coldTempAlertEnabled", "hotTempAlertEnabled", "humidityHighAlert", "humidityLowAlert", "wifiOfflineAlert", "tempAlertNotify", "humidityAlertNotify", "tempAlertNotifyTechnician", "humidityAlertNotifyTechnician", "serviceRemindMe", "serviceRemindTechnician", "monthsBetweenService", "lastServiceDate", "remindMeDate", "heatRangeLow", "heatRangeHigh", "coolRangeLow", "coolRangeHigh", "heatCoolMinDelta", "tempCorrection", "autoHeatCoolFeatureEnabled", "compressorProtectionMinTime", "compressorProtectionMinTemp", "stage1HeatingDifferentialTemp", "stage1CoolingDifferentialTemp", "stage1HeatingDissipationTime", "stage1CoolingDissipationTime", "heatPumpReversalOnCool", "fanControlRequired", "auxMaxOutdoorTemp", "eiLocation", "maxSetBack", "maxSetForward", "quickSaveSetBack", "quickSaveSetForward", "soundTickVolume", "soundAlertVolume", "auxRuntimeAlert", "auxOutdoorTempAlert", "auxRuntimeAlertNotify", "auxOutdoorTempAlertNotify", "auxRuntimeAlertNotifyTechnician", "auxOutdoorTempAlertNotifyTechnician", "disablePreHeating", "disablePreCooling", "isRentalProperty", "useZoneController", "randomStartDelayHeat", "randomStartDelayCool", "disableHeatPumpAlerts", "disableAlertsOnIdt", "monthlyElectricityBillLimit", "enableElectricityBillAlert", "enableProjectedElectricityBillAlert", "electricityBillingDayOfMonth", "electricityBillCycleMonths", "electricityBillStartMonth", "isVentilatorTimerOn", "hasUVFilter", "coolingLockout", "ventilatorFreeCooling", "dehumidifyWhenHeating", "ventilatorDehumidify", "fanSpeed", "displayAirQuality"];
        const advanced = ["heatRangeLow", "heatRangeHigh", "coolRangeLow", "coolRangeHigh", "heatCoolMinDelta", "tempCorrection", "autoHeatCoolFeatureEnabled", "compressorProtectionMinTime", "compressorProtectionMinTemp", "stage1HeatingDifferentialTemp", "stage1CoolingDifferentialTemp", "stage1HeatingDissipationTime", "stage1CoolingDissipationTime", "heatPumpReversalOnCool", "fanControlRequired", "auxMaxOutdoorTemp", "maxSetBack", "maxSetForward", "isRentalProperty", "useZoneController", "randomStartDelayHeat", "randomStartDelayCool", "disableHeatPumpAlerts", "disableAlertsOnIdt", "hasUVFilter", "coolingLockout", "dehumidifyWhenHeating", "ventilatorDehumidify"];
        for (const [key, value] of Object.entries(patch)) {
          if (!allowed.includes(key) || forbidden.test(key) || !Object.hasOwn(settings, key) || !scalar(value) ||
              (typeof value === "string" && value.length > (key === "eiLocation" ? 255 : 80)) || ((advanced.includes(key) || (key === "hvacMode" && value === "auxHeatOnly")) && input.allow_advanced_settings !== true)) return fail("invalid_input");
          if (key === "hvacMode" && !["off", "heat", "cool", "auto", "auxHeatOnly"].includes(value as string)) return fail("invalid_input");
          if (key === "fanMinOnTime" && (!finite(value, 0, 60) || !Number.isInteger(value))) return fail("invalid_input");
          if (key === "humidity" && (typeof value !== "string" || !/^(?:100|[1-9]?\d)$/.test(value))) return fail("invalid_input");
          const enums: Record<string, string[]> = { holdAction: ["useEndTime4hour", "useEndTime2hour", "nextPeriod", "indefinite", "askMe"], humidifierMode: ["auto", "manual", "off"], dehumidifierMode: ["on", "off"], vent: ["auto", "minontime", "on", "off"], locale: ["en"], fanSpeed: ["low", "medium_low", "medium", "medium_high", "high", "optimized"] };
          if (enums[key] && !enums[key].includes(value as string)) return fail("invalid_input");
          if (typeof value === "string" && /[\u0000-\u001f\u007f]/.test(value)) return fail("invalid_input");
          if (typeof settings[key] === "boolean" && typeof value !== "boolean") return fail("invalid_input");
          if (typeof settings[key] === "number" && !finite(value)) return fail("invalid_input");
        }
        if (patch.fanSpeed !== undefined) {
          const wire = fanWireSpeed(patch.fanSpeed);
          if (!wire) return unsupported("set_fan_speed");
          requestedFanSpeed = patch.fanSpeed as string;
          patch.fanSpeed = wire;
        }
        const merged = { ...settings, ...patch };
        for (const [low, high] of [["heatRangeLow", "heatRangeHigh"], ["coolRangeLow", "coolRangeHigh"], ["humidityLowAlert", "humidityHighAlert"], ["coldTempAlert", "hotTempAlert"]]) {
          if ((Object.hasOwn(patch, low) || Object.hasOwn(patch, high)) && finite(merged[low]) && finite(merged[high]) && merged[low] > merged[high]) return fail("invalid_input");
        }
        if (patch.dehumidifyWithAC === true && !finite(patch.dehumidifyOvercoolOffset, 1, 50)) return fail("invalid_input");
        action = "updateThermostatProperties"; args = [ids, { settings: patch }]; break;
      }
      case "set_comfort_setting": {
        const climate = Array.isArray(program?.climates) ? program.climates.map(object).find(value => value?.climateRef === input.climate_ref) : undefined;
        const hold = duration();
        if (!climate || !hold) return fail("invalid_input");
        action = "setHold"; args = [ids, { ...hold, holdClimateRef: input.climate_ref }]; break;
      }
      case "update_comfort_setting":
      case "create_comfort_setting":
      case "delete_comfort_setting":
      case "set_schedule": {
        if (!program || !Array.isArray(program.climates) || program.climates.length > 64 || !Array.isArray(program.schedule)) return fail("invalid_response");
        let climates = program.climates.map(value => ({ ...object(value) }));
        let schedule: unknown = program.schedule;
        if (request.name === "set_schedule") {
          const refs = new Set(climates.map(climate => climate.climateRef));
          if (!Array.isArray(input.schedule) || input.schedule.length !== 7 || input.schedule.some(day => !Array.isArray(day) || day.length !== 48 || day.some(ref => typeof ref !== "string" || !refs.has(ref)))) return fail("invalid_input");
          schedule = input.schedule;
        } else if (request.name === "delete_comfort_setting") {
          if (typeof input.climate_ref !== "string" || ["home", "away", "sleep", "wakeup", "occupied", "unoccupied"].includes(input.climate_ref) ||
              !climates.some(climate => climate.climateRef === input.climate_ref) || climates.length < 2 ||
              program.schedule.some(day => !Array.isArray(day) || day.includes(input.climate_ref)) ||
              events.some(event => event.running === true && event.holdClimateRef === input.climate_ref)) return fail("invalid_input");
          climates = climates.filter(climate => climate.climateRef !== input.climate_ref);
        } else {
          let climate: Obj | undefined;
          if (request.name === "create_comfort_setting") {
            if (climates.length >= 64 || typeof input.name !== "string" || input.heat === undefined || input.cool === undefined) return fail("invalid_input");
            // Exact wire defaults from the portal's getNewClimateObject and
            // ClimateParser; omit climateRef so the server generates it.
            climate = { name: input.name, colour: 9021815, coolFan: "auto", heatFan: "auto", isOccupied: false, isOptimized: true,
              owner: "user", type: "program", ventilatorMinOnTime: 20,
              sensors: sensors.map(temperatureReference).filter((reference): reference is string => reference !== undefined).map(reference => ({ id: reference })) };
            climates.push(climate);
          } else climate = climates.find(value => value.climateRef === input.climate_ref);
          if (!climate || (input.name === undefined && input.heat === undefined && input.cool === undefined && input.sensor_ids === undefined && input.heat_fan === undefined && input.cool_fan === undefined && input.is_occupied === undefined && input.is_optimized === undefined && input.vent === undefined && input.ventilator_min_on_time === undefined && input.colour === undefined)) return fail("invalid_input");
          if (input.name !== undefined) {
            if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 32 || /[\u0000-\u001f\u007f]/.test(input.name) || climates.some(other => other !== climate && other.name === input.name)) return fail("invalid_input");
            climate.name = input.name;
          }
          const heat = input.heat === undefined ? climate.heatTemp : canonical(input.heat), cool = input.cool === undefined ? climate.coolTemp : canonical(input.cool);
          if (input.heat !== undefined || input.cool !== undefined) {
            if (!temperaturesValid(heat, cool)) return fail("temperature_range");
            climate.heatTemp = heat; climate.coolTemp = cool;
          }
          for (const [from, to] of [["heat_fan", "heatFan"], ["cool_fan", "coolFan"]]) {
            if (input[from] !== undefined) { if (!["auto", "on"].includes(input[from] as string)) return fail("invalid_input"); climate[to] = input[from]; }
          }
          for (const [from, to] of [["is_occupied", "isOccupied"], ["is_optimized", "isOptimized"]]) {
            if (input[from] !== undefined) { if (typeof input[from] !== "boolean") return fail("invalid_input"); climate[to] = input[from]; }
          }
          if (input.vent !== undefined) { if (!["auto", "minontime", "on", "off"].includes(input.vent as string)) return fail("invalid_input"); climate.vent = input.vent; }
          if (input.ventilator_min_on_time !== undefined) { if (!finite(input.ventilator_min_on_time, 0, 60) || !Number.isInteger(input.ventilator_min_on_time)) return fail("invalid_input"); climate.ventilatorMinOnTime = input.ventilator_min_on_time; }
          if (input.colour !== undefined) { if (!finite(input.colour, 0, 0xffffff) || !Number.isInteger(input.colour)) return fail("invalid_input"); climate.colour = input.colour; }
          if (input.sensor_ids !== undefined) {
            if (!Array.isArray(input.sensor_ids) || input.sensor_ids.length > 64 || new Set(input.sensor_ids).size !== input.sensor_ids.length) return fail("invalid_input");
            const references = input.sensor_ids.map(sensorId => { const sensor = findSensor(sensorId); return sensor ? temperatureReference(sensor) : undefined; });
            if (references.some(reference => reference === undefined) || new Set(references).size !== references.length) return fail("invalid_input");
            climate.sensors = references.map(reference => ({ id: reference }));
          }
        }
        action = "updateThermostatProperties"; args = [ids, { program: { schedule, climates } }]; break;
      }
      case "set_fan": {
        const hold = duration();
        if (!hold || !["on", "auto"].includes(input.mode as string) || !finite(runtime.desiredHeat, -400, 2200) || !finite(runtime.desiredCool, -400, 2200)) return fail("invalid_input");
        action = "setHold"; args = [ids, { ...hold, fan: input.mode, coolHoldTemp: runtime.desiredCool, heatHoldTemp: runtime.desiredHeat, isTemperatureAbsolute: false, isTemperatureRelative: false }]; break;
      }
      case "create_vacation": {
        const heat = canonical(input.heat), cool = canonical(input.cool);
        if (!temperaturesValid(heat, cool)) return fail("temperature_range");
        const vacationName = text(input.name, 32);
        if (!vacationName || vacationName !== input.name || events.some(event => event.type === "vacation" && event.name === vacationName)) return fail("invalid_input");
        const date = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
        const time = (value: unknown) => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value);
        if (!date(input.start_date) || !date(input.end_date) || !time(input.start_time) || !time(input.end_time) || `${input.start_date} ${input.start_time}` >= `${input.end_date} ${input.end_time}` ||
            (input.fan !== undefined && !["auto", "on"].includes(input.fan as string)) || (input.fan_min_on_time !== undefined && (!finite(input.fan_min_on_time, 0, 60) || !Number.isInteger(input.fan_min_on_time)))) return fail("invalid_input");
        action = "createVacation"; args = [ids, { name: vacationName, heatHoldTemp: heat, coolHoldTemp: cool,
          startDate: input.start_date, startTime: input.start_time, endDate: input.end_date, endTime: input.end_time,
          fanMinOnTime: input.fan_min_on_time ?? 0, isHeatOff: false, isCoolOff: false, fan: input.fan ?? "auto" }]; break;
      }
      case "delete_vacation": {
        const vacation = events.find(event => event.type === "vacation" && event.name === input.name);
        if (!vacation) return fail("invalid_input");
        action = "deleteVacation"; args = [ids, input.name]; break;
      }
      case "rename_sensor": {
        const sensor = findSensor(input.sensor_id);
        const capability = Array.isArray(sensor?.capability) ? object(sensor.capability[0]) : undefined;
        const sensorCapability = capabilityId(capability);
        if (!sensor || sensorCapability === undefined || !text(input.name, 32) || text(input.name, 32) !== input.name) return fail("invalid_input");
        action = "renameSensor"; args = [ids, sensor.id, sensorCapability, input.name]; break;
      }
      case "acknowledge_alert": {
        const alerts = Array.isArray(target.alerts) ? target.alerts.map(object) : [];
        if (!alerts.some(alert => {
          const reference = alert?.acknowledgeRef;
          return typeof reference === "string" ? reference === input.ack_ref : typeof reference === "number" && Number.isSafeInteger(reference) && reference >= 0 && String(reference) === input.ack_ref;
        }) || !["accept", "decline", "defer", "unacknowledged"].includes(input.ack_type as string) ||
            (input.remind_me_later !== undefined && typeof input.remind_me_later !== "boolean")) return fail("invalid_input");
        action = "acknowledgeAlert"; args = [ids, input.ack_ref, input.ack_type, input.remind_me_later ?? false]; break;
      }
      case "send_message":
        if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.text)) return fail("invalid_input");
        // The portal exports updateThermostat(ids, thermostat, functions).
        // Official SendMessage documents only the fixed {text} parameter.
        action = "updateThermostat"; args = [ids, undefined, [{ type: "sendMessage", params: { text: input.text } }]]; break;
      case "update_notification_settings": {
        const current = object(target.notificationSettings);
        const patch = object(input.patch);
        if (!current) return unsupported(request.name);
        if (!patch || !Object.keys(patch).length || Object.keys(patch).some(key => !["emailNotificationsEnabled", "equipment", "general", "limit"].includes(key))) return fail("invalid_input");
        const changed: Obj = {};
        if (patch.emailNotificationsEnabled !== undefined) {
          if (typeof patch.emailNotificationsEnabled !== "boolean" || typeof current.emailNotificationsEnabled !== "boolean") return fail("invalid_input");
          changed.emailNotificationsEnabled = patch.emailNotificationsEnabled;
        }
        const mergedLimits = new Map<string, Obj>();
        if (Array.isArray(current.limit)) for (const value of current.limit) { const entry = object(value); if (typeof entry?.type === "string") mergedLimits.set(entry.type, entry); }
        const changedLimitTypes = new Set<string>();
        for (const category of ["equipment", "general", "limit"]) {
          if (patch[category] === undefined) continue;
          const entries = patch[category], existing = current[category];
          if (!Array.isArray(entries) || !entries.length || entries.length > 64 || !Array.isArray(existing)) return fail("invalid_input");
          const seen = new Set<string>();
          const updates: Obj[] = [];
          for (const value of entries) {
            const entry = object(value);
            if (!entry || typeof entry.type !== "string" || entry.type.length > 64 || seen.has(entry.type) || Object.keys(entry).length < 2) return fail("invalid_input");
            seen.add(entry.type);
            const previous = existing.map(object).find(candidate => candidate?.type === entry.type);
            if (!previous) return unsupported(request.name);
            const permitted = category === "equipment" ? ["type", "enabled", "remindTechnician", "filterLastChanged", "filterLife", "filterLifeUnits"] : category === "general" ? ["type", "enabled", "remindTechnician"] : ["type", "enabled", "remindTechnician", "limit"];
            if (Object.keys(entry).some(key => !permitted.includes(key)) ||
                (entry.enabled !== undefined && typeof entry.enabled !== "boolean") || (entry.remindTechnician !== undefined && typeof entry.remindTechnician !== "boolean")) return fail("invalid_input");
            const effective = { ...previous, ...entry };
            if (category === "equipment") {
              if ((entry.filterLife === undefined) !== (entry.filterLifeUnits === undefined)) return fail("invalid_input");
              if (entry.filterLife !== undefined && (!Number.isInteger(entry.filterLife) ||
                  (entry.filterLifeUnits === "month" ? !finite(entry.filterLife, 1, 12) : entry.filterLifeUnits === "hour" ? !finite(entry.filterLife, 100, 10000) : true))) return fail("invalid_input");
              if (entry.filterLastChanged !== undefined && (typeof entry.filterLastChanged !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.filterLastChanged) || !Number.isFinite(Date.parse(`${entry.filterLastChanged}T00:00:00Z`)) || new Date(`${entry.filterLastChanged}T00:00:00Z`).toISOString().slice(0, 10) !== entry.filterLastChanged)) return fail("invalid_input");
            } else if (category === "general") {
              if (entry.type !== "temp") return fail("invalid_input");
            } else {
              if (!["lowTemp", "highTemp", "lowHumidity", "highHumidity", "auxHeat", "auxOutdoor"].includes(entry.type)) return fail("invalid_input");
              if (entry.limit !== undefined && (!finite(entry.limit, -400, 86400) || !Number.isInteger(entry.limit))) return fail("invalid_input");
              if (["lowTemp", "highTemp"].includes(entry.type) && !finite(effective.limit, -400, 2200)) return fail("invalid_input");
              if (["lowHumidity", "highHumidity"].includes(entry.type) && (effective.enabled === true ? !finite(effective.limit, 5, 95) : entry.limit !== undefined && entry.limit !== -1 && !finite(entry.limit, 5, 95))) return fail("invalid_input");
              if (entry.type === "auxHeat" && (!finite(effective.limit, 0, 86400) || (effective.enabled === true && effective.limit === 0))) return fail("invalid_input");
              if (entry.type === "auxOutdoor" && (effective.enabled === true ? !finite(effective.limit, 320, 790) : entry.limit !== undefined && entry.limit !== 800 && !finite(entry.limit, 320, 790))) return fail("invalid_input");
              mergedLimits.set(entry.type, effective); changedLimitTypes.add(entry.type);
            }
            // Match the observed portal form: keyed partial entries only. Do
            // not send absent arrays, email addresses or computed reminder dates.
            updates.push({ ...entry });
          }
          changed[category] = updates;
        }
        for (const [low, high, gap] of [["lowTemp", "highTemp", settings.heatCoolMinDelta], ["lowHumidity", "highHumidity", 5]] as const) {
          if (!changedLimitTypes.has(low) && !changedLimitTypes.has(high)) continue;
          const a = mergedLimits.get(low), b = mergedLimits.get(high);
          if (a?.enabled === true && b?.enabled === true && (!finite(a.limit) || !finite(b.limit) || !finite(gap, 0, 500) || b.limit - a.limit < gap)) return fail("invalid_input");
        }
        action = "updateThermostatProperties"; args = [ids, { notificationSettings: changed }]; break;
      }
      case "update_house_details": {
        const patch = object(input.patch);
        const allowed = ["style", "size", "numberOfFloors", "numberOfRooms", "numberOfOccupants", "age", "windowEfficiency"];
        if (!patch || !Object.keys(patch).length || Object.keys(patch).some(key => !allowed.includes(key))) return fail("invalid_input");
        for (const [key, value] of Object.entries(patch)) {
          if (key === "style" ? !["apartment", "condominium", "detached", "loft", "multiPlex", "other", "rowHouse", "semiDetached", "townhouse", "0"].includes(value as string) : !finite(value, 0, key === "size" ? 100000 : 1000) || !Number.isInteger(value) || (key === "windowEfficiency" && !finite(value, 1, 7))) return fail("invalid_input");
        }
        action = "updateThermostatProperties"; args = [ids, { houseDetails: patch }]; break;
      }
      default: return unsupported(request.name);
    }
    writeStarted = true;
    const written = await call(() => api.connectToReduxConnectionManager(action, args));
    const invalid = checked(written); if (invalid) return invalid;
    if (request.name === "create_group") {
      const reread = await call(() => api.getGroups!());
      const bad = checked(reread); if (bad) return fail("write_uncertain", reread);
      const groups = object(reread)?.groups;
      const created = Array.isArray(groups) ? groups.map(object).find(group => Boolean(group) && group!.groupName === input.name && Array.isArray(group!.thermostats) && group!.thermostats.includes(id)) : undefined;
      const ref = created?.groupRef;
      const candidate = typeof ref === "string" ? ref : typeof ref === "number" && Number.isSafeInteger(ref) ? String(ref) : "";
      const reference = /^[A-Za-z0-9_:-]{1,64}$/.test(candidate) ? candidate : null;
      return success({ thermostat_id: id, delivery: "accepted", verification: reference ? "observed" : "pending", verification_scope: "created_reference", group_ref: reference, name: text(input.name, 32) });
    }
    if (["set_eco_plus", "set_smart_recovery", "set_demand_response_preference", "set_installer_code_required", "create_comfort_setting", "rename_thermostat", "set_fan_speed", "update_audio", "set_timezone"].includes(request.name) || requestedFanSpeed !== undefined) {
      const reread = await call(() => api.getThermostats({ selection: { selectionType: "registered", ...(request.name === "set_eco_plus" ? { includeEnergy: true } : request.name === "create_comfort_setting" ? { includeProgram: true } : request.name === "update_audio" ? { includeAudio: true } : request.name === "set_timezone" ? { includeLocation: true } : { includeSettings: true }) } }));
      const badReadback = checked(reread); if (badReadback) return fail("write_uncertain", reread);
      const values = object(reread)?.thermostatList;
      const after = Array.isArray(values) ? values.map(object).find(value => value?.identifier === id) : undefined;
      if (request.name === "set_eco_plus") {
        const state = object(after?.energy)?.energyFeatureState;
        return success({ thermostat_id: id, delivery: "accepted", verification: state === (input.enabled ? "enabled" : "disabled") ? "observed" : "pending", energyFeatureState: typeof state === "string" ? text(state, 40) : null });
      }
      if (request.name === "rename_thermostat") return success({ thermostat_id: id, delivery: "accepted", verification: after?.name === input.name ? "observed" : "pending", name: text(after?.name, 20) || null });
      if (request.name === "create_comfort_setting") {
        const afterProgram = object(after?.program);
        const climate = Array.isArray(afterProgram?.climates) ? afterProgram.climates.map(object).find(value => value?.name === input.name) : undefined;
        const reference = typeof climate?.climateRef === "string" && /^[A-Za-z0-9_:-]{1,64}$/.test(climate.climateRef) ? climate.climateRef : null;
        return success({ thermostat_id: id, delivery: "accepted", verification: reference ? "observed" : "pending", verification_scope: "created_reference", climate_ref: reference, name: text(input.name, 32) });
      }
      if (request.name === "update_audio" || request.name === "set_timezone") {
        const key = request.name === "update_audio" ? "audio" : "location";
        const current = object(after?.[key]);
        const patch = object(object(args[1])?.[key]) ?? {};
        const observed = Boolean(current) && Object.entries(patch).every(([field, expected]) => current![field] === expected);
        const reported: Obj = {};
        for (const field of Object.keys(patch)) reported[field] = current?.[field] === undefined ? null : clean(current[field]);
        return success({ thermostat_id: id, delivery: "accepted", verification: observed ? "observed" : "pending", [key]: reported });
      }
      const afterSettings = object(after?.settings);
      const patch = object(object(args[1])?.settings) ?? {};
      const observed = Boolean(afterSettings) && Object.entries(patch).every(([key, expected]) => afterSettings![key] === expected);
      const reported: Obj = {};
      for (const key of Object.keys(patch)) reported[key] = afterSettings?.[key] === undefined ? null : clean(afterSettings[key]);
      return success({ thermostat_id: id, delivery: "accepted", verification: observed ? "observed" : "pending", settings: reported,
        ...(requestedFanSpeed === undefined ? {} : { requested_speed: requestedFanSpeed, requested_wire_speed: patch.fanSpeed, reported_wire_speed: typeof afterSettings?.fanSpeed === "string" ? text(afterSettings.fanSpeed, 40) : null }) });
    }
    return success({ thermostat_id: id, operation: request.name, delivery: "accepted", verification: "not_verified" });
  } catch (error) {
    const record = object(error);
    if (object(record?.status)?.code === 14 || record?.status === 401 || record?.error === "invalid_grant") return fail("login_required", error);
    return fail(writeStarted ? "write_uncertain" : error === "feature_timeout" ? "timeout" : "request_failed", error);
  }
}
