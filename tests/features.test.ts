import { describe, expect, it } from "vitest";
import { advancedSettingsKeys, featureDefinitions, featureReadOnly, parseFeatureRequest, unsupportedFeatures, writableSettingsKeys } from "../src/features.js";
import { UserError } from "../src/types.js";

const thermostat_id = "123456789012";
const parse = (name: string, input: Record<string, unknown> = {}) => parseFeatureRequest({ name, input: { thermostat_id, ...input } });

describe("thermostat feature catalog", () => {
  it("declares unique names, read/write intent, and required exact targets for every tool", () => {
    expect(new Set(featureDefinitions.map(definition => definition.name)).size).toBe(featureDefinitions.length);
    expect(featureDefinitions.length).toBe(46);
    for (const definition of featureDefinitions) {
      expect(definition.description.length).toBeGreaterThan(20);
      expect(definition.inputSchema.shape.thermostat_id.isOptional()).toBe(false);
      expect(featureReadOnly(definition.name)).toBe(definition.readOnly);
    }
    expect(featureReadOnly("get_energy_status")).toBe(true);
    expect(featureReadOnly("set_eco_plus")).toBe(false);
  });

  it.each(["", "-1", "123,456", "1 OR 1=1", "https://example.org", "1".repeat(33)])("rejects an invalid target %s", thermostat_id => {
    expect(() => parse("get_settings", { thermostat_id })).toThrow(UserError);
  });

  it("rejects unknown tools and input fields without echoing supplied secrets", () => {
    expect(() => featureReadOnly("PRIVATE TOKEN")).toThrow("Unsupported thermostat feature");
    expect(() => parse("account_password", { token: "PRIVATE" })).toThrow("Unsupported thermostat feature");
    expect(() => parse("get_settings", { script: "PRIVATE", url: "https://example.org" })).toThrow("Invalid input");
    expect(() => parseFeatureRequest({ name: "get_settings", input: { thermostat_id }, token: "PRIVATE" } as never)).toThrow("Invalid thermostat feature request");
  });

  it("defaults detailed reads to sections that exclude personal and account data", () => {
    expect(parse("get_thermostat_details").input.sections).toEqual(["runtime", "settings", "events"]);
    expect(parse("get_thermostat_details", { sections: ["energy", "sensors"] }).input.sections).toEqual(["energy", "sensors"]);
    expect(() => parse("get_thermostat_details", { sections: ["credentials"] })).toThrow(UserError);
  });

  it.each(["hasHeatPump", "coolStages", "heatMinTemp", "userAccessCode", "userAccessSetting", "energyFeatureState", "unknownField"])("rejects read-only or unknown setting %s", key => {
    expect(() => parse("update_settings", { patch: { [key]: true }, allow_advanced_settings: true })).toThrow(UserError);
    expect(writableSettingsKeys).not.toContain(key);
  });

  it("accepts documented ordinary preferences and rejects wrong types or bounds", () => {
    expect(parse("update_settings", { patch: { fanMinOnTime: 15, followMeComfort: true, humidity: "45" } }).input)
      .toMatchObject({ allow_advanced_settings: false, patch: { fanMinOnTime: 15, followMeComfort: true, humidity: "45" } });
    for (const patch of [{ fanMinOnTime: 61 }, { fanMinOnTime: 1.5 }, { followMeComfort: "yes" }, { humidity: 45 }, { humidity: "101" }, { hvacMode: "eco+" }, {}]) {
      expect(() => parse("update_settings", { patch })).toThrow(UserError);
    }
  });

  it("requires explicit advanced intent without granting write access to capability flags", () => {
    expect(advancedSettingsKeys).toContain("compressorProtectionMinTime");
    expect(() => parse("update_settings", { patch: { compressorProtectionMinTime: 300 } })).toThrow(UserError);
    expect(() => parse("update_settings", { patch: { hvacMode: "auxHeatOnly" } })).toThrow(UserError);
    expect(parse("update_settings", { patch: { compressorProtectionMinTime: 300 }, allow_advanced_settings: true }).input.patch)
      .toEqual({ compressorProtectionMinTime: 300 });
    expect(() => parse("update_settings", { patch: { heatRangeLow: 800, heatRangeHigh: 700 }, allow_advanced_settings: true })).toThrow(UserError);
  });

  it("covers 91 audited writable settings while retaining all documented read-only boundaries", () => {
    expect(writableSettingsKeys).toHaveLength(91);
    for (const key of ["coolStages", "heatStages", "hasHeatPump", "hasForcedAir", "hasBoiler", "hasHumidifier", "hasErv", "hasHrv", "heatPumpGroundWater", "hasElectric", "hasDehumidifier", "heatMinTemp", "heatMaxTemp", "coolMinTemp", "coolMaxTemp", "userAccessCode", "userAccessSetting", "ventilatorType", "ventilatorOffDateTime"]) {
      expect(writableSettingsKeys).not.toContain(key);
      expect(() => parse("update_settings", { patch: { [key]: true }, allow_advanced_settings: true })).toThrow(UserError);
    }
    expect(parse("update_settings", { patch: { fanSpeed: "optimized", electricityBillingDayOfMonth: 31, electricityBillCycleMonths: 2, displayAirQuality: true } }).input.patch)
      .toEqual({ fanSpeed: "optimized", electricityBillingDayOfMonth: 31, electricityBillCycleMonths: 2, displayAirQuality: true });
    expect(parse("update_settings", { patch: { hasUVFilter: true, randomStartDelayHeat: 3600 }, allow_advanced_settings: true }).input.patch)
      .toEqual({ hasUVFilter: true, randomStartDelayHeat: 3600 });
    expect(() => parse("update_settings", { patch: { randomStartDelayCool: 3601 }, allow_advanced_settings: true })).toThrow(UserError);
    expect(() => parse("update_settings", { patch: { fanSpeed: "turbo" } })).toThrow(UserError);
    expect(() => parse("update_settings", { patch: { electricityBillingDayOfMonth: 32 } })).toThrow(UserError);
  });

  it("exposes normal Smart Recovery preferences with unambiguous enabled polarity", () => {
    expect(parse("set_smart_recovery", { heat_enabled: true, cool_enabled: false }).input)
      .toEqual({ thermostat_id, heat_enabled: true, cool_enabled: false });
    expect(() => parse("set_smart_recovery")).toThrow(UserError);
    expect(() => parse("set_smart_recovery", { heat_enabled: "yes" })).toThrow(UserError);
    expect(parse("update_settings", { patch: { disablePreHeating: false, disablePreCooling: true } }).input.patch)
      .toEqual({ disablePreHeating: false, disablePreCooling: true });
    const tool = featureDefinitions.find(feature => feature.name === "set_smart_recovery")!;
    expect(tool.description).toContain("without canceling the active hold");
  });

  it("makes local installer and demand-response preferences explicit named controls", () => {
    expect(parse("set_installer_code_required", { required: true }).input).toEqual({ thermostat_id, required: true });
    expect(parse("set_demand_response_preference", { preference: "askMe" }).input).toEqual({ thermostat_id, preference: "askMe" });
    expect(() => parse("set_demand_response_preference", { preference: "enroll" })).toThrow(UserError);
    expect(() => parse("set_installer_code_required", { required: true, code: "PRIVATE" })).toThrow(UserError);
    expect(() => parse("update_settings", { patch: { installerCodeRequired: true }, allow_advanced_settings: true })).toThrow(UserError);
    expect(() => parse("update_settings", { patch: { drAccept: "always" }, allow_advanced_settings: true })).toThrow(UserError);
    expect(featureReadOnly("set_demand_response_preference")).toBe(false);
    expect(featureReadOnly("set_installer_code_required")).toBe(false);
  });

  it("allows a bounded comfort-setting rename while preserving its reference", () => {
    expect(parse("update_comfort_setting", { climate_ref: "home", name: "At Home", unit: "F" }).input)
      .toEqual({ thermostat_id, climate_ref: "home", name: "At Home", unit: "F" });
    expect(() => parse("update_comfort_setting", { climate_ref: "home", name: "a".repeat(33), unit: "F" })).toThrow(UserError);
  });

  it("bounds thermostat naming and exposes explicit comfort-setting creation and deletion", () => {
    expect(parse("rename_thermostat", { name: "Living Room" }).input.name).toBe("Living Room");
    expect(() => parse("rename_thermostat", { name: "x".repeat(21) })).toThrow(UserError);
    expect(parse("create_comfort_setting", { name: "Reading", heat: 68, cool: 76, unit: "F", vent: "off", is_occupied: true, colour: 9021815 }).input.name).toBe("Reading");
    expect(() => parse("create_comfort_setting", { name: "Reading", heat: 68, cool: 76, unit: "F", climate_ref: "made-up" })).toThrow(UserError);
    expect(parse("delete_comfort_setting", { climate_ref: "smart1" }).input.climate_ref).toBe("smart1");
    expect(parse("update_comfort_setting", { climate_ref: "smart1", unit: "F", is_optimized: false, ventilator_min_on_time: 20 }).input.is_optimized).toBe(false);
    expect(() => parse("update_comfort_setting", { climate_ref: "smart1", unit: "F", colour: 0x1000000 })).toThrow(UserError);
  });

  it("accepts only bounded documented reminder edits without changing computed dates or recipients", () => {
    expect(featureReadOnly("get_notification_settings")).toBe(true);
    expect(parse("update_notification_settings", { patch: { equipment: [{ type: "furnaceFilter", filterLastChanged: "2026-10-17", filterLife: 3, filterLifeUnits: "month", enabled: true }] } }).input.patch)
      .toEqual({ equipment: [{ type: "furnaceFilter", filterLastChanged: "2026-10-17", filterLife: 3, filterLifeUnits: "month", enabled: true }] });
    expect(parse("update_notification_settings", { patch: { general: [{ type: "temp", enabled: false }], emailNotificationsEnabled: true } }).input.patch)
      .toEqual({ general: [{ type: "temp", enabled: false }], emailNotificationsEnabled: true });
    for (const patch of [
      {}, { equipment: [{ type: "furnaceFilter" }] },
      { equipment: [{ type: "furnaceFilter", filterLife: 13, filterLifeUnits: "month" }] },
      { equipment: [{ type: "furnaceFilter", filterLife: 99, filterLifeUnits: "hour" }] },
      { equipment: [{ type: "furnaceFilter", filterLife: 3 }] },
      { equipment: [{ type: "furnaceFilter", remindMeDate: "2026-12-01" }] },
      { general: [{ type: "security", enabled: true }] },
      { emailRecipients: ["private@example.org"] },
    ]) expect(() => parse("update_notification_settings", { patch })).toThrow(UserError);
  });

  it("validates reminder limit types, ranges, and duplicate identities", () => {
    expect(parse("update_notification_settings", { patch: { limit: [{ type: "auxOutdoor", limit: 400, enabled: true }] } }).input.patch)
      .toEqual({ limit: [{ type: "auxOutdoor", limit: 400, enabled: true }] });
    expect(parse("update_notification_settings", { patch: { limit: [{ type: "auxOutdoor", limit: 800, enabled: false }] } }).input.patch)
      .toEqual({ limit: [{ type: "auxOutdoor", limit: 800, enabled: false }] });
    for (const limit of [
      [{ type: "unknown", enabled: true }], [{ type: "lowHumidity", limit: 100 }],
      [{ type: "auxOutdoor", limit: 800, enabled: true }], [{ type: "auxHeat", limit: 0, enabled: true }],
      [{ type: "highTemp", limit: 3000 }], [{ type: "lowTemp", enabled: true }, { type: "lowTemp", enabled: false }],
    ]) expect(() => parse("update_notification_settings", { patch: { limit } })).toThrow(UserError);
  });

  it("requires an explicit reset confirmation and preserves group membership in the schema", () => {
    expect(() => parse("reset_preferences")).toThrow(UserError);
    expect(() => parse("reset_preferences", { confirm_reset: false })).toThrow(UserError);
    expect(parse("reset_preferences", { confirm_reset: true }).input).toEqual({ thermostat_id, confirm_reset: true });
    expect(parse("update_group", { group_ref: "group1", patch: { groupName: "Home", synchronizeSchedule: true } }).input.patch)
      .toEqual({ groupName: "Home", synchronizeSchedule: true });
    expect(() => parse("update_group", { group_ref: "group1", patch: { thermostats: [] } })).toThrow(UserError);
    expect(() => parse("update_group", { group_ref: "group1", patch: {} })).toThrow(UserError);
    expect(() => parse("update_group", { group_ref: "group1", patch: { synchronizeReset: "yes" } })).toThrow(UserError);
    expect(parse("update_group", { group_ref: "group1", thermostat_ids: [thermostat_id, "123"] }).input.thermostat_ids).toEqual([thermostat_id, "123"]);
    expect(() => parse("update_group", { group_ref: "group1", thermostat_ids: ["123"] })).toThrow(UserError);
    expect(() => parse("update_group", { group_ref: "group1", thermostat_ids: [] })).toThrow(UserError);
    expect(() => parse("create_group", { name: "Home", thermostat_ids: [thermostat_id, thermostat_id] })).toThrow(UserError);
    expect(() => parse("create_group", { name: "Home", thermostat_ids: ["123"] })).toThrow(UserError);
    expect(parse("create_group", { name: "Home", thermostat_ids: [thermostat_id] }).input.synchronizeReset).toBe(false);
    expect(parse("create_group", { name: "Home", thermostat_ids: [thermostat_id], synchronizeSchedule: true }).input.synchronizeSchedule).toBe(true);
    expect(() => parse("delete_group", { group_ref: "group1" })).toThrow(UserError);
    expect(() => parse("delete_group", { group_ref: "group1", confirm_delete: false })).toThrow(UserError);
    expect(parse("delete_group", { group_ref: "group1", confirm_delete: true }).input.confirm_delete).toBe(true);
  });

  it("requires explicit ordered local datetimes for a date-time hold", () => {
    const hold = { cool: 72, unit: "F", start_date: "2026-12-01", start_time: "09:00:00", end_date: "2026-12-01", end_time: "18:00:00" };
    expect(parse("set_temperature_until", hold).input.cool).toBe(72);
    expect(() => parse("set_temperature_until", { ...hold, cool: undefined })).toThrow(UserError);
    expect(() => parse("set_temperature_until", { ...hold, end_time: "08:00:00" })).toThrow(UserError);
    expect(() => parse("set_temperature_until", { ...hold, start_date: "2026-02-30" })).toThrow(UserError);
    expect(parse("set_temperature_until", { cool: 72, unit: "F", end_date: "2026-12-01", end_time: "18:00:00" }).input.start_date).toBeUndefined();
    expect(() => parse("set_temperature_until", { cool: 72, unit: "F", start_date: "2026-12-01", end_date: "2026-12-01", end_time: "18:00:00" })).toThrow(UserError);
    expect(parse("resume_all_events").input).toEqual({ thermostat_id });
    expect(() => parse("resume_all_events", { delete_vacations: true })).toThrow(UserError);
  });

  it("allows bounded report windows to retrieve complete chunks", () => {
    const window = { start_date: "2026-10-17", end_date: "2026-10-17", start_interval: 0, end_interval: 11 };
    expect(parse("get_runtime_report", window).input.end_interval).toBe(11);
    expect(() => parse("get_runtime_report", { ...window, start_interval: 12 })).toThrow(UserError);
    expect(() => parse("get_runtime_report", { ...window, end_interval: 288 })).toThrow(UserError);
    expect(() => parse("get_runtime_report", { ...window, start_interval: -1 })).toThrow(UserError);
    expect(() => parse("get_runtime_report", { ...window, start_interval: 1.5 })).toThrow(UserError);
  });

  it("restricts audio, timezone, and persistent fan preferences to verified forms", () => {
    expect(parse("update_audio", { patch: { playbackVolume: 100, microphoneEnabled: false, soundTickVolume: 0 } }).input.patch)
      .toEqual({ playbackVolume: 100, microphoneEnabled: false, soundTickVolume: 0 });
    expect(() => parse("update_audio", { patch: { playbackVolume: 101 } })).toThrow(UserError);
    expect(() => parse("update_audio", { patch: { microphoneEnabled: "enabled" } })).toThrow(UserError);
    expect(() => parse("update_audio", { patch: { voiceEngines: [] } })).toThrow(UserError);
    expect(() => parse("update_audio", { patch: {} })).toThrow(UserError);
    expect(parse("set_timezone", { time_zone: "America/Chicago", is_daylight_saving: true }).input.time_zone).toBe("America/Chicago");
    expect(() => parse("set_timezone", { time_zone: "Invalid/Zone" })).toThrow(UserError);
    expect(() => parse("set_timezone", { time_zone: "America/Chicago", streetAddress: "PRIVATE" })).toThrow(UserError);
    expect(() => parse("set_timezone")).toThrow(UserError);
    expect(parse("set_fan_speed", { speed: "high" }).input.speed).toBe("high");
    expect(() => parse("set_fan_speed", { speed: "turbo" })).toThrow(UserError);
  });

  it("validates coupled dehumidification settings", () => {
    expect(() => parse("update_settings", { patch: { dehumidifyWithAC: true } })).toThrow(UserError);
    expect(() => parse("update_settings", { patch: { dehumidifyWithAC: true, dehumidifyOvercoolOffset: 0 } })).toThrow(UserError);
    expect(() => parse("update_settings", { patch: { dehumidifyOvercoolOffset: 7 } })).toThrow(UserError);
    expect(parse("update_settings", { patch: { dehumidifyWithAC: true, dehumidifyOvercoolOffset: 10 } }).input.patch)
      .toEqual({ dehumidifyWithAC: true, dehumidifyOvercoolOffset: 10 });
  });

  it("offers only the verified eco+ master switch and records individual-feature limitations", () => {
    expect(parse("set_eco_plus", { enabled: false }).input).toEqual({ thermostat_id, enabled: false });
    expect(() => parse("set_eco_plus", { enabled: "yes" })).toThrow(UserError);
    expect(() => parse("set_eco_plus", { enabled: true, enroll: true })).toThrow(UserError);
    expect(unsupportedFeatures.map(feature => feature.name)).toEqual(expect.arrayContaining(["eco_plus_individual_features", "utility_enrollment", "account_security"]));
  });

  it("requires a consistent explicit hold duration for fan and comfort holds", () => {
    for (const [name, change] of [["set_fan", { mode: "on" }], ["set_comfort_setting", { climate_ref: "home" }]] as const) {
      expect(parse(name, { ...change, hold_type: "indefinite" }).input.hold_type).toBe("indefinite");
      expect(parse(name, { ...change, hold_type: "hours", hours: 2 }).input.hours).toBe(2);
      for (const duration of [{}, { hold_type: "hours" }, { hold_type: "hours", hours: 25 }, { hold_type: "next_transition", hours: 1 }]) {
        expect(() => parse(name, { ...change, ...duration })).toThrow(UserError);
      }
    }
  });

  it("validates program reference syntax, requested changes, and unique sensor participation", () => {
    expect(parse("update_comfort_setting", { climate_ref: "smart1", unit: "F", heat: 67, sensor_ids: ["rs:100:1"] }).input.climate_ref).toBe("smart1");
    for (const input of [
      { climate_ref: "home; execute()", unit: "F", heat: 67 },
      { climate_ref: "home", unit: "F" },
      { climate_ref: "home", unit: "F", sensor_ids: ["rs:100:1", "rs:100:1"] },
      { climate_ref: "home", unit: "C", cool: 200 },
    ]) expect(() => parse("update_comfort_setting", input)).toThrow(UserError);
  });

  it("requires seven full days of existing-reference-shaped half-hour schedule cells", () => {
    const schedule = Array.from({ length: 7 }, () => Array(48).fill("home"));
    expect(parse("set_schedule", { schedule }).input.schedule).toEqual(schedule);
    expect(() => parse("set_schedule", { schedule: schedule.slice(0, 6) })).toThrow(UserError);
    expect(() => parse("set_schedule", { schedule: [...schedule.slice(0, 6), Array(47).fill("home")] })).toThrow(UserError);
    expect(() => parse("set_schedule", { schedule: Array.from({ length: 7 }, () => Array(48).fill("")) })).toThrow(UserError);
  });

  it("validates real report dates, chronological ordering, and the 31-day inclusive cap", () => {
    expect(parse("get_runtime_report", { start_date: "2028-02-29", end_date: "2028-03-01", columns: ["fan", "zoneAveTemp"] }).input.columns).toEqual(["fan", "zoneAveTemp"]);
    expect(parse("get_runtime_report", { start_date: "2026-10-01", end_date: "2026-10-31" }).input.end_date).toBe("2026-10-31");
    for (const input of [
      { start_date: "2026-02-29", end_date: "2026-03-01" },
      { start_date: "2026-11-01", end_date: "2026-10-31" },
      { start_date: "2026-10-01", end_date: "2026-11-01" },
      { start_date: "2026-10-01", end_date: "2026-10-01", columns: ["fan", "fan"] },
      { start_date: "2026-10-01", end_date: "2026-10-01", columns: ["fan;DROP"] },
    ]) expect(() => parse("get_runtime_report", input)).toThrow(UserError);
  });

  it("requires ordered vacation dates and local clock times without guessing durations", () => {
    const vacation = { name: "Trip", heat: 60, cool: 80, unit: "F", start_date: "2026-12-01", start_time: "08:00:00", end_date: "2026-12-08", end_time: "18:00:00", fan_min_on_time: 0 };
    expect(parse("create_vacation", vacation).input.name).toBe("Trip");
    expect(() => parse("create_vacation", { ...vacation, end_date: "2026-11-30" })).toThrow(UserError);
    expect(() => parse("create_vacation", { ...vacation, start_time: "24:00:00" })).toThrow(UserError);
    expect(() => parse("create_vacation", { ...vacation, end_date: "2026-02-30" })).toThrow(UserError);
  });

  it("bounds sensor names and thermostat messages", () => {
    expect(parse("rename_sensor", { sensor_id: "rs:100:1", name: "Bedroom" }).input.name).toBe("Bedroom");
    expect(() => parse("rename_sensor", { sensor_id: "rs:100:1", name: "a".repeat(33) })).toThrow(UserError);
    expect(() => parse("send_message", { text: "a".repeat(501) })).toThrow(UserError);
    expect(() => parse("send_message", { text: "hello\u0000PRIVATE" })).toThrow(UserError);
  });

  it("restricts alert acknowledgements and house edits to their documented forms", () => {
    expect(parse("acknowledge_alert", { ack_ref: "alert-1", ack_type: "defer", remind_me_later: true }).input.ack_type).toBe("defer");
    expect(() => parse("acknowledge_alert", { ack_ref: "alert-1", ack_type: "accept", remind_me_later: true })).toThrow(UserError);
    expect(() => parse("update_house_details", { patch: { streetAddress: "PRIVATE" } })).toThrow(UserError);
    expect(() => parse("update_house_details", { patch: { windowEfficiency: 8 } })).toThrow(UserError);
    expect(parse("update_house_details", { patch: { style: "detached", size: 1800, numberOfOccupants: 3 } }).input.patch)
      .toEqual({ style: "detached", size: 1800, numberOfOccupants: 3 });
  });
});
