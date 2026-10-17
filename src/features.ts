import { z } from "zod";
import type { FeatureRequest } from "./feature-types.js";
import { UserError } from "./types.js";

const thermostatId = z.string().regex(/^[0-9]{1,32}$/, "Use the exact thermostat id returned by list_thermostats.");
const text = (maximum: number) => z.string().min(1).max(maximum).regex(/^[^\u0000-\u001f\u007f]+$/);
const reference = z.string().min(1).max(64).regex(/^[A-Za-z0-9_:-]+$/);
const sensorId = z.string().min(1).max(96).regex(/^[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+){1,3}$/);
const integer = (minimum: number, maximum: number) => z.number().int().min(minimum).max(maximum);
const temperature = z.number().finite().min(-40).max(220);
const canonicalTemperature = integer(-400, 2200).describe("Canonical temperature: degrees Fahrenheit multiplied by 10.");
const fan = z.enum(["auto", "on"]);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}, "Use a real calendar date in YYYY-MM-DD format.");
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/).describe("HH:MM:SS in the thermostat's local timezone.");
const timeZone = z.string().min(1).max(128).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "Use a valid IANA timezone such as America/Chicago.");
const target = { thermostat_id: thermostatId };
const duration = {
  hold_type: z.enum(["hours", "indefinite", "next_transition"]),
  hours: integer(1, 24).optional(),
};
function validateDuration(input: { hold_type: string; hours?: number }, context: z.RefinementCtx) {
  if (input.hold_type === "hours" && input.hours === undefined) context.addIssue({ code: "custom", path: ["hours"], message: "Timed holds require 1–24 whole hours." });
  if (input.hold_type !== "hours" && input.hours !== undefined) context.addIssue({ code: "custom", path: ["hours"], message: "Only timed holds accept hours." });
}

// Writable fields verified against the official Settings object. Bounds here
// limit inputs; the device's current hardware and configured limits still apply.
// https://developer.ecobee.com/home/developer/api/documentation/v1/objects/Settings.shtml
const settingsPatch = z.object({
  hvacMode: z.enum(["auto", "auxHeatOnly", "cool", "heat", "off"]).optional(),
  fanMinOnTime: integer(0, 60).optional(),
  holdAction: z.enum(["useEndTime4hour", "useEndTime2hour", "nextPeriod", "indefinite", "askMe"]).optional(),
  useCelsius: z.boolean().optional(), useTimeFormat12: z.boolean().optional(), locale: z.literal("en").optional(),
  autoAway: z.boolean().optional(), followMeComfort: z.boolean().optional(), smartCirculation: z.boolean().optional(),
  humidity: z.string().regex(/^(?:100|[1-9]?\d)$/).optional(),
  humidifierMode: z.enum(["auto", "manual", "off"]).optional(),
  dehumidifierMode: z.enum(["on", "off"]).optional(), dehumidifierLevel: integer(0, 100).optional(),
  condensationAvoid: z.boolean().optional(), dehumidifyWithAC: z.boolean().optional(),
  dehumidifyOvercoolOffset: integer(0, 50).multipleOf(5).optional(),
  vent: z.enum(["auto", "minontime", "on", "off"]).optional(),
  ventilatorMinOnTime: integer(0, 60).optional(), ventilatorMinOnTimeHome: integer(0, 60).optional(), ventilatorMinOnTimeAway: integer(0, 60).optional(),
  backlightOnIntensity: integer(0, 10).optional(), backlightSleepIntensity: integer(0, 10).optional(),
  backlightOffTime: integer(0, 3600).optional(), backlightOffDuringSleep: z.boolean().optional(),
  coldTempAlert: canonicalTemperature.optional(), hotTempAlert: canonicalTemperature.optional(),
  coldTempAlertEnabled: z.boolean().optional(), hotTempAlertEnabled: z.boolean().optional(),
  humidityHighAlert: integer(0, 100).optional(), humidityLowAlert: integer(0, 100).optional(),
  wifiOfflineAlert: z.boolean().optional(), tempAlertNotify: z.boolean().optional(), humidityAlertNotify: z.boolean().optional(),
  tempAlertNotifyTechnician: z.boolean().optional(), humidityAlertNotifyTechnician: z.boolean().optional(),
  serviceRemindMe: z.boolean().optional(), serviceRemindTechnician: z.boolean().optional(),
  monthsBetweenService: integer(1, 120).optional(), lastServiceDate: date.optional(), remindMeDate: date.optional(),
  heatRangeLow: canonicalTemperature.optional(), heatRangeHigh: canonicalTemperature.optional(),
  coolRangeLow: canonicalTemperature.optional(), coolRangeHigh: canonicalTemperature.optional(),
  heatCoolMinDelta: integer(0, 100).optional(), tempCorrection: integer(-100, 100).optional(),
  autoHeatCoolFeatureEnabled: z.boolean().optional(),
  compressorProtectionMinTime: integer(60, 1800).optional(), compressorProtectionMinTemp: canonicalTemperature.optional(),
  stage1HeatingDifferentialTemp: integer(0, 100).optional(), stage1CoolingDifferentialTemp: integer(0, 100).optional(),
  stage1HeatingDissipationTime: integer(0, 1800).optional(), stage1CoolingDissipationTime: integer(0, 1800).optional(),
  heatPumpReversalOnCool: z.boolean().optional(), fanControlRequired: z.boolean().optional(), auxMaxOutdoorTemp: canonicalTemperature.optional(),
  eiLocation: text(255).optional(),
  maxSetBack: integer(0, 1000).optional(), maxSetForward: integer(0, 1000).optional(),
  quickSaveSetBack: integer(0, 1000).optional(), quickSaveSetForward: integer(0, 1000).optional(),
  soundTickVolume: integer(1, 10).describe("Legacy Settings volume, deprecated in favor of Audio; supported portal values 1–10.").optional(),
  soundAlertVolume: integer(1, 10).describe("Legacy Settings volume, deprecated in favor of Audio; supported portal values 1–10.").optional(),
  auxRuntimeAlert: integer(0, 86400).describe("Raw API threshold; read the current value first. Documentation does not clearly specify units.").optional(),
  auxOutdoorTempAlert: canonicalTemperature.optional(),
  auxRuntimeAlertNotify: z.boolean().optional(), auxOutdoorTempAlertNotify: z.boolean().optional(),
  auxRuntimeAlertNotifyTechnician: z.boolean().optional(), auxOutdoorTempAlertNotifyTechnician: z.boolean().optional(),
  disablePreHeating: z.boolean().describe("Smart Recovery for heat: true disables it; false enables it.").optional(),
  disablePreCooling: z.boolean().describe("Smart Recovery for cool: true disables it; false enables it.").optional(),
  isRentalProperty: z.boolean().optional(), useZoneController: z.boolean().optional(),
  randomStartDelayHeat: integer(0, 3600).describe("Seconds, as validated by the official portal.").optional(),
  randomStartDelayCool: integer(0, 3600).describe("Seconds, as validated by the official portal.").optional(),
  disableHeatPumpAlerts: z.boolean().optional(), disableAlertsOnIdt: z.boolean().optional(),
  monthlyElectricityBillLimit: integer(0, 1000000).describe("Electricity bill alert threshold in dollars; this does not create a charge.").optional(),
  enableElectricityBillAlert: z.boolean().optional(), enableProjectedElectricityBillAlert: z.boolean().optional(),
  electricityBillingDayOfMonth: integer(1, 31).optional(), electricityBillCycleMonths: integer(1, 12).optional(), electricityBillStartMonth: integer(1, 12).optional(),
  isVentilatorTimerOn: z.boolean().describe("True starts the thermostat's 20-minute ventilator timer; false stops that timer.").optional(),
  hasUVFilter: z.boolean().describe("Documented writable UV-filter configuration; requires explicit advanced intent.").optional(),
  coolingLockout: z.boolean().optional(), ventilatorFreeCooling: z.boolean().optional(), dehumidifyWhenHeating: z.boolean().optional(), ventilatorDehumidify: z.boolean().optional(),
  fanSpeed: z.enum(["low", "medium_low", "medium", "medium_high", "high", "optimized"]).optional(),
  displayAirQuality: z.boolean().describe("False also disables air-quality automation and notifications, according to ecobee.").optional(),
}).strict().refine(input => Object.keys(input).length > 0, "Provide at least one supported writable setting.");

export const advancedSettingsKeys = ["heatRangeLow", "heatRangeHigh", "coolRangeLow", "coolRangeHigh", "heatCoolMinDelta", "tempCorrection", "autoHeatCoolFeatureEnabled", "compressorProtectionMinTime", "compressorProtectionMinTemp", "stage1HeatingDifferentialTemp", "stage1CoolingDifferentialTemp", "stage1HeatingDissipationTime", "stage1CoolingDissipationTime", "heatPumpReversalOnCool", "fanControlRequired", "auxMaxOutdoorTemp", "maxSetBack", "maxSetForward", "isRentalProperty", "useZoneController", "randomStartDelayHeat", "randomStartDelayCool", "disableHeatPumpAlerts", "disableAlertsOnIdt", "hasUVFilter", "coolingLockout", "dehumidifyWhenHeating", "ventilatorDehumidify"] as const;
export const writableSettingsKeys = Object.keys(settingsPatch.shape);

const updateSettings = z.object({ ...target, patch: settingsPatch, allow_advanced_settings: z.boolean().default(false) }).strict().superRefine((input, context) => {
  if (!input.allow_advanced_settings && (advancedSettingsKeys.some(key => input.patch[key] !== undefined) || input.patch.hvacMode === "auxHeatOnly")) {
    context.addIssue({ code: "custom", path: ["allow_advanced_settings"], message: "Advanced HVAC configuration requires explicit user intent and allow_advanced_settings=true." });
  }
  for (const [low, high] of [["heatRangeLow", "heatRangeHigh"], ["coolRangeLow", "coolRangeHigh"], ["humidityLowAlert", "humidityHighAlert"], ["coldTempAlert", "hotTempAlert"]] as const) {
    if (input.patch[low] !== undefined && input.patch[high] !== undefined && input.patch[low]! > input.patch[high]!) {
      context.addIssue({ code: "custom", path: ["patch", low], message: "The low limit must not exceed the high limit." });
    }
  }
  if (input.patch.dehumidifyWithAC === true && !(typeof input.patch.dehumidifyOvercoolOffset === "number" && input.patch.dehumidifyOvercoolOffset > 0)) {
    context.addIssue({ code: "custom", path: ["patch", "dehumidifyOvercoolOffset"], message: "AC dehumidification requires a positive overcool offset in the same patch." });
  }
});

const housePatch = z.object({
  style: z.enum(["other", "apartment", "condominium", "detached", "loft", "multiPlex", "rowHouse", "semiDetached", "townhouse", "0"]).optional(),
  size: integer(1, 100000).optional(), numberOfFloors: integer(1, 100).optional(), numberOfRooms: integer(1, 1000).optional(),
  numberOfOccupants: integer(0, 1000).optional(), age: integer(0, 1000).optional(), windowEfficiency: integer(1, 7).optional(),
}).strict().refine(input => Object.keys(input).length > 0, "Provide at least one supported house detail.");

export interface FeatureDefinition {
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema: z.ZodObject;
}
const read = (name: string, description: string): FeatureDefinition => ({ name, description, readOnly: true, inputSchema: z.object(target).strict() });
const write = (name: string, description: string, inputSchema: z.ZodObject): FeatureDefinition => ({ name, description, readOnly: false, inputSchema });

const comfortUpdate = z.object({
  ...target, climate_ref: reference, name: text(32).optional(), heat: temperature.optional(), cool: temperature.optional(), unit: z.enum(["F", "C"]),
  sensor_ids: z.array(sensorId).max(64).optional(), heat_fan: fan.optional(), cool_fan: fan.optional(),
  is_occupied: z.boolean().optional(), is_optimized: z.boolean().optional(), vent: z.enum(["auto", "minontime", "on", "off"]).optional(),
  ventilator_min_on_time: integer(0, 60).optional(), colour: integer(0, 0xffffff).optional(),
}).strict().superRefine((input, context) => {
  if ([input.name, input.heat, input.cool, input.sensor_ids, input.heat_fan, input.cool_fan, input.is_occupied, input.is_optimized, input.vent, input.ventilator_min_on_time, input.colour].every(value => value === undefined)) context.addIssue({ code: "custom", message: "Provide a comfort-setting change." });
  if (input.unit === "C" && [input.heat, input.cool].some(value => value !== undefined && (value < -40 || value > 104.4))) context.addIssue({ code: "custom", message: "Temperature is outside the supported Celsius input bounds." });
  if (input.sensor_ids && new Set(input.sensor_ids).size !== input.sensor_ids.length) context.addIssue({ code: "custom", path: ["sensor_ids"], message: "Sensor ids must be unique." });
});

const notificationEquipment = z.object({
  type: text(64), filterLastChanged: date.optional(), filterLife: integer(1, 10000).optional(),
  filterLifeUnits: z.enum(["month", "hour"]).optional(), enabled: z.boolean().optional(), remindTechnician: z.boolean().optional(),
}).strict().superRefine((input, context) => {
  if (Object.keys(input).length <= 1) context.addIssue({ code: "custom", message: "Provide a change for the existing equipment reminder type." });
  if ((input.filterLife === undefined) !== (input.filterLifeUnits === undefined)) context.addIssue({ code: "custom", message: "Provide filterLife and filterLifeUnits together." });
  if (input.filterLife !== undefined && ((input.filterLifeUnits === "month" && input.filterLife > 12) || (input.filterLifeUnits === "hour" && input.filterLife < 100))) context.addIssue({ code: "custom", path: ["filterLife"], message: "Filter life must be 1–12 months or 100–10000 hours." });
});
const notificationGeneral = z.object({ type: z.literal("temp"), enabled: z.boolean().optional(), remindTechnician: z.boolean().optional() }).strict()
  .refine(input => input.enabled !== undefined || input.remindTechnician !== undefined, "Provide a general reminder change.");
const notificationLimit = z.object({
  type: z.enum(["lowTemp", "highTemp", "lowHumidity", "highHumidity", "auxHeat", "auxOutdoor"]),
  limit: integer(-400, 86400).optional(), enabled: z.boolean().optional(), remindTechnician: z.boolean().optional(),
}).strict().superRefine((input, context) => {
  if (Object.keys(input).length <= 1) context.addIssue({ code: "custom", message: "Provide a change for the existing limit reminder type." });
  if (input.limit === undefined) return; // The adapter merges and validates the current device value.
  if ((input.type === "lowTemp" || input.type === "highTemp") && input.limit > 2200) context.addIssue({ code: "custom", path: ["limit"], message: "Temperature limits use canonical Fahrenheit × 10." });
  if ((input.type === "lowHumidity" || input.type === "highHumidity") && !((input.limit >= 5 && input.limit <= 95) || (input.enabled === false && input.limit === -1))) context.addIssue({ code: "custom", path: ["limit"], message: "Humidity limits must be 5–95 percent, or -1 when explicitly disabled." });
  if (input.type === "auxHeat" && (input.limit < 0 || (input.enabled === true && input.limit === 0))) context.addIssue({ code: "custom", path: ["limit"], message: "An enabled auxiliary-heat runtime threshold must be positive." });
  if (input.type === "auxOutdoor" && !((input.limit >= 320 && input.limit <= 790) || (input.enabled === false && input.limit === 800))) context.addIssue({ code: "custom", path: ["limit"], message: "Auxiliary outdoor thresholds must be 320–790 canonical Fahrenheit, or 800 when explicitly disabled." });
});
const notificationsPatch = z.object({
  emailNotificationsEnabled: z.boolean().optional(), equipment: z.array(notificationEquipment).min(1).max(32).optional(),
  general: z.array(notificationGeneral).min(1).max(1).optional(), limit: z.array(notificationLimit).min(1).max(6).optional(),
}).strict().superRefine((input, context) => {
  if (Object.keys(input).length === 0) context.addIssue({ code: "custom", message: "Provide a notification settings change." });
  for (const category of ["equipment", "general", "limit"] as const) {
    const entries = input[category];
    if (entries && new Set(entries.map(entry => entry.type)).size !== entries.length) context.addIssue({ code: "custom", path: [category], message: "Reminder types must be unique within a patch." });
  }
});

const groupPatch = z.object({
  groupName: text(32).optional(), synchronizeAlerts: z.boolean().optional(), synchronizeSystemMode: z.boolean().optional(),
  synchronizeSchedule: z.boolean().optional(), synchronizeQuickSave: z.boolean().optional(), synchronizeReminders: z.boolean().optional(),
  synchronizeContractorInfo: z.boolean().optional(), synchronizeUserPreferences: z.boolean().optional(), synchronizeUtilityInfo: z.boolean().optional(),
  synchronizeLocation: z.boolean().optional(), synchronizeReset: z.boolean().optional(), synchronizeVacation: z.boolean().optional(),
}).strict().refine(input => Object.keys(input).length > 0, "Provide a change to the existing group.");
const groupMembers = z.array(thermostatId).min(1).max(200).refine(values => new Set(values).size === values.length, "Group members must be unique.");

export const featureDefinitions: FeatureDefinition[] = [
  { name: "get_thermostat_details", description: "Read selected thermostat sections. Location, house, utility, technician, and audio data are returned only when explicitly selected; no account security or utility enrollment changes.", readOnly: true,
    inputSchema: z.object({ ...target, sections: z.array(z.enum(["runtime", "settings", "program", "events", "sensors", "weather", "alerts", "energy", "extended_runtime", "electricity", "devices", "location", "house_details", "utility", "technician", "audio"])).min(1).max(16).default(["runtime", "settings", "events"]) }).strict() },
  read("get_settings", "Read the current thermostat settings and hardware configuration."),
  read("get_comfort_settings", "Read existing comfort settings and their exact climate references."),
  read("get_schedule", "Read the weekly schedule and its comfort-setting references."),
  read("get_sensors", "Read attached sensors, capabilities, and participation information."),
  read("get_weather", "Read the thermostat's weather information."),
  read("get_alerts", "Read thermostat alerts without acknowledging or changing them."),
  read("get_notification_settings", "Read thermostat alert thresholds and equipment/service reminder configuration without exposing notification recipient addresses."),
  read("get_events", "Read active and upcoming thermostat events, including holds and demand response."),
  read("get_energy_status", "Read exposed energy and eco+ state without changing settings or utility enrollment."),
  read("get_equipment_status", "Read which supported HVAC equipment is currently running."),
  read("get_vacations", "Read vacation events and their exact names."),
  { name: "get_runtime_report", description: "Read a bounded runtime report for at most 31 inclusive days; timestamps use UTC. Five-minute start/end intervals are 0–287. Responses may be truncated: request smaller interval windows or fewer columns for complete data. Avoid repeated report polling more often than every 15 minutes.", readOnly: true,
    inputSchema: z.object({ ...target, start_date: date, end_date: date, start_interval: integer(0, 287).optional(), end_interval: integer(0, 287).optional(), columns: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/)).min(1).max(32).optional() }).strict().superRefine((input, context) => {
      const days = (Date.parse(`${input.end_date}T00:00:00Z`) - Date.parse(`${input.start_date}T00:00:00Z`)) / 86400000;
      if (days < 0 || days > 30) context.addIssue({ code: "custom", path: ["end_date"], message: "Report dates must be ordered and span at most 31 inclusive days." });
      if (days === 0 && (input.start_interval ?? 0) > (input.end_interval ?? 287)) context.addIssue({ code: "custom", path: ["end_interval"], message: "A same-day report must end at or after its start interval." });
      if (input.columns && new Set(input.columns).size !== input.columns.length) context.addIssue({ code: "custom", path: ["columns"], message: "Report columns must be unique." });
    }) },
  read("get_extended_runtime", "Read the thermostat's extended runtime data when supported."),
  read("get_house_details", "Read house characteristics only for this explicitly requested thermostat."),
  read("get_utility_info", "Read utility metadata; this does not enroll, unenroll, or modify a utility program."),
  read("get_technician_info", "Read the technician information associated with this thermostat when explicitly requested."),
  read("get_groups", "Read available thermostat groups after verifying ownership of the target thermostat."),
  write("update_settings", "Change only supplied documented writable settings. Temperature integers use tenths of Fahrenheit. Installer/HVAC configuration requires explicit user intent and allow_advanced_settings=true. Hardware capabilities, account security, utility enrollment, and eco+ enablement are excluded.", updateSettings),
  write("set_eco_plus", "Enable or disable the eco+ master setting only when explicitly requested. The thermostat must expose the supported energy master state. This does not enroll in utility programs or configure individual eco+ features.", z.object({ ...target, enabled: z.boolean() }).strict()),
  write("set_smart_recovery", "Enable or disable heating and/or cooling Smart Recovery. It preconditions scheduled comfort periods and does not run during an indefinite hold. This changes the preference without canceling the active hold.", z.object({ ...target, heat_enabled: z.boolean().optional(), cool_enabled: z.boolean().optional() }).strict().refine(input => input.heat_enabled !== undefined || input.cool_enabled !== undefined, "Provide heat_enabled or cool_enabled.")),
  write("set_demand_response_preference", "Set how this thermostat accepts future demand-response requests, only when explicitly requested. This changes acceptance behavior; it does not enroll or unenroll a utility program or cancel active events.", z.object({ ...target, preference: z.enum(["always", "askMe", "customerSelect", "defaultAccept", "defaultDecline", "never"]) }).strict()),
  write("set_installer_code_required", "Set whether this thermostat requires an installer code, only when explicitly requested. This is a local thermostat preference; the actual code is neither read nor changed.", z.object({ ...target, required: z.boolean() }).strict()),
  write("rename_thermostat", "Rename this thermostat using a name of at most 20 characters, as supported by the official portal. No ownership or account details change.", z.object({ ...target, name: text(20) }).strict()),
  write("update_audio", "Change only supplied audio preferences exposed by this thermostat. Change microphoneEnabled only when the user explicitly requests that microphone state. Playback volume is 0–100 and alert/tick volumes are 0–10. Voice-engine linking and account grants are excluded.", z.object({ ...target, patch: z.object({ playbackVolume: integer(0, 100).optional(), microphoneEnabled: z.boolean().optional(), soundAlertVolume: integer(0, 10).optional(), soundTickVolume: integer(0, 10).optional() }).strict().refine(input => Object.keys(input).length > 0, "Provide an audio change.") }).strict()),
  write("set_timezone", "Change the thermostat's IANA timezone and/or explicit daylight-saving flag. The adapter preserves the other current location fields. No address, phone number, coordinates, or account ownership changes are accepted.", z.object({ ...target, time_zone: timeZone.optional(), is_daylight_saving: z.boolean().optional() }).strict().refine(input => input.time_zone !== undefined || input.is_daylight_saving !== undefined, "Provide a timezone or daylight-saving flag.")),
  write("set_fan_speed", "Change the persistent fan-speed preference only for speeds supported by the thermostat's current fan capabilities. Existing fan mode and holds are preserved; the adapter handles the verified two-speed API mapping.", z.object({ ...target, speed: z.enum(["low", "medium_low", "medium", "medium_high", "high", "optimized"]) }).strict()),
  write("reset_preferences", "Reset this thermostat's user preferences and program only when the user specifically requests that reset. Installer and Wi-Fi configuration are unaffected. Requires confirm_reset=true; never use this as a routine troubleshooting or setup step.", z.object({ ...target, confirm_reset: z.literal(true) }).strict()),
  write("update_group", "Update an existing owned thermostat group's name, synchronization preferences, or explicitly supplied full membership. Omitted membership and flags are preserved. All members must be owned, include the target thermostat, and cannot be implicitly moved from another group. Synchronization can propagate future schedule, mode, vacation, alert, location, utility, or reset changes to every member.", z.object({ ...target, group_ref: reference, patch: groupPatch.optional(), thermostat_ids: groupMembers.optional() }).strict().superRefine((input, context) => {
    if (!input.patch && !input.thermostat_ids) context.addIssue({ code: "custom", message: "Provide a group preference or membership change." });
    if (input.thermostat_ids && !input.thermostat_ids.includes(input.thermostat_id)) context.addIssue({ code: "custom", path: ["thermostat_ids"], message: "Group membership must include the target thermostat." });
  })),
  write("create_group", "Create a named group containing the explicitly supplied owned thermostats, including the target. A thermostat already in another group cannot be moved implicitly. Synchronization flags default to false; enabled flags can propagate future changes to all members. Existing groups are preserved.", z.object({
    ...target, name: text(32), thermostat_ids: groupMembers,
    synchronizeAlerts: z.boolean().default(false), synchronizeSystemMode: z.boolean().default(false), synchronizeSchedule: z.boolean().default(false),
    synchronizeQuickSave: z.boolean().default(false), synchronizeReminders: z.boolean().default(false), synchronizeContractorInfo: z.boolean().default(false),
    synchronizeUserPreferences: z.boolean().default(false), synchronizeUtilityInfo: z.boolean().default(false), synchronizeLocation: z.boolean().default(false),
    synchronizeReset: z.boolean().default(false), synchronizeVacation: z.boolean().default(false),
  }).strict().refine(input => input.thermostat_ids.includes(input.thermostat_id), "Group membership must include the target thermostat.")),
  write("delete_group", "Delete the specifically identified owned thermostat group only when explicitly requested, with confirm_delete=true. All its members must be owned by this account. Thermostat registrations and unrelated groups remain preserved.", z.object({ ...target, group_ref: reference, confirm_delete: z.literal(true) }).strict()),
  write("set_comfort_setting", "Apply an existing comfort setting as a hold. Use the exact climate_ref returned by get_comfort_settings and an explicit duration.", z.object({ ...target, climate_ref: reference, ...duration }).strict().superRefine(validateDuration)),
  write("set_temperature_until", "Set a temperature hold until an explicit end date and time in the thermostat's local timezone. Omit both start fields to start now, or provide both for a scheduled start. Provide heat, cool, or both and an explicit unit; omitted setpoints are preserved from current device state.", z.object({
    ...target, heat: temperature.optional(), cool: temperature.optional(), unit: z.enum(["F", "C"]), start_date: date.optional(), start_time: time.optional(), end_date: date, end_time: time,
  }).strict().superRefine((input, context) => {
    if (input.heat === undefined && input.cool === undefined) context.addIssue({ code: "custom", message: "Provide heat, cool, or both setpoints." });
    if ((input.start_date === undefined) !== (input.start_time === undefined)) context.addIssue({ code: "custom", path: ["start_date"], message: "Provide both start_date and start_time, or omit both to start now." });
    if (input.start_date !== undefined && input.start_time !== undefined && `${input.end_date}T${input.end_time}` <= `${input.start_date}T${input.start_time}`) context.addIssue({ code: "custom", path: ["end_date"], message: "Hold end must be after its start in thermostat local time." });
    if (input.unit === "C" && [input.heat, input.cool].some(value => value !== undefined && value > 104.4)) context.addIssue({ code: "custom", message: "Temperature is outside the supported Celsius input bounds." });
  })),
  write("resume_all_events", "Resume the scheduled program across all resumable events only when the user explicitly requests an all-event resume. This does not delete vacation records or enroll/unenroll utility programs.", z.object(target).strict()),
  write("update_comfort_setting", "Update an existing comfort setting's name, temperatures, sensor participation, or fan modes. Its exact climate_ref is preserved and sensor ids must already exist; all schedule periods using this setting are affected.", comfortUpdate),
  write("create_comfort_setting", "Create a uniquely named comfort setting with explicit temperatures and units while preserving the existing program and schedule. Ecobee generates its reference; supplied sensor ids must already exist.", z.object({
    ...target, name: text(32), heat: temperature, cool: temperature, unit: z.enum(["F", "C"]),
    sensor_ids: z.array(sensorId).max(64).optional(), heat_fan: fan.optional(), cool_fan: fan.optional(),
    is_occupied: z.boolean().optional(), is_optimized: z.boolean().optional(), vent: z.enum(["auto", "minontime", "on", "off"]).optional(),
    ventilator_min_on_time: integer(0, 60).optional(), colour: integer(0, 0xffffff).optional(),
  }).strict().superRefine((input, context) => {
    if (input.unit === "C" && (input.heat > 104.4 || input.cool > 104.4)) context.addIssue({ code: "custom", message: "Temperature is outside the supported Celsius input bounds." });
    if (input.sensor_ids && new Set(input.sensor_ids).size !== input.sensor_ids.length) context.addIssue({ code: "custom", path: ["sensor_ids"], message: "Sensor ids must be unique." });
  })),
  write("delete_comfort_setting", "Delete an existing custom comfort setting only if it is not referenced by the schedule. Built-in default settings cannot be deleted; the remaining program is preserved.", z.object({ ...target, climate_ref: reference }).strict()),
  write("set_schedule", "Replace the weekly schedule with exactly seven Sunday-first days of 48 half-hour cells. Each cell must reference an existing comfort setting; other program data is preserved.", z.object({ ...target, schedule: z.array(z.array(reference).length(48)).length(7) }).strict()),
  write("set_fan", "Set a fan hold using auto/on and an explicit duration; no equipment configuration is changed.", z.object({ ...target, mode: fan, ...duration }).strict().superRefine(validateDuration)),
  write("create_vacation", "Create a named vacation with explicit temperature unit and start/end dates and times in the thermostat's local timezone.", z.object({
    ...target, name: text(32), heat: temperature, cool: temperature, unit: z.enum(["F", "C"]), start_date: date, start_time: time, end_date: date, end_time: time,
    fan: fan.optional(), fan_min_on_time: integer(0, 60).optional(),
  }).strict().superRefine((input, context) => {
    if (`${input.end_date}T${input.end_time}` <= `${input.start_date}T${input.start_time}`) context.addIssue({ code: "custom", path: ["end_date"], message: "Vacation end must be after its start in thermostat local time." });
    if (input.unit === "C" && (input.heat > 104.4 || input.cool > 104.4)) context.addIssue({ code: "custom", message: "Temperature is outside the supported Celsius input bounds." });
  })),
  write("delete_vacation", "Delete the specifically named vacation event; no unrelated events are changed.", z.object({ ...target, name: text(32) }).strict()),
  write("rename_sensor", "Rename an existing remote sensor using its exact sensor_id from get_sensors. Model support is checked before dispatch.", z.object({ ...target, sensor_id: sensorId, name: text(32) }).strict()),
  write("acknowledge_alert", "Acknowledge the exact alert reference using accept, decline, defer, or unacknowledged. This does not authorize utility enrollment or account-security changes.", z.object({ ...target, ack_ref: text(128), ack_type: z.enum(["accept", "decline", "defer", "unacknowledged"]), remind_me_later: z.boolean().optional() }).strict().superRefine((input, context) => {
    if (input.remind_me_later !== undefined && input.ack_type !== "defer") context.addIssue({ code: "custom", path: ["remind_me_later"], message: "remind_me_later applies only to a deferred acknowledgement." });
  })),
  write("send_message", "Display a message of at most 500 characters on the target thermostat. This does not send email, SMS, or chat messages.", z.object({ ...target, text: text(500) }).strict()),
  write("update_house_details", "Update only supplied house characteristics; window efficiency can affect frost-control behavior. Address, account ownership, security, and utility enrollment are excluded.", z.object({ ...target, patch: housePatch }).strict()),
  write("update_notification_settings", "Change only supplied existing thermostat reminder types, merging current equipment/general/limit settings. Dates use YYYY-MM-DD; temperature limits use Fahrenheit × 10 and humidity uses percent. Current paired thresholds are checked to avoid changing an unrequested peer. Notification addresses and computed reminder dates cannot be changed.", z.object({ ...target, patch: notificationsPatch }).strict()),
];

export const unsupportedFeatures = [
  { name: "eco_plus_individual_features", reason: "Individual eco+ feature toggles, savings levels, and a today-only pause have not been verified through this browser adapter. The supported master enable/disable control is separate." },
  { name: "utility_enrollment", reason: "Utility-program enrollment and withdrawal are not implemented. The separately exposed demand-response acceptance preference changes future-request handling without enrolling or withdrawing a program." },
  { name: "account_security", reason: "Account credentials, actual access-code values, account-security settings, and linked-app grants are not exposed. The local installer-code-required preference is a separate explicit control." },
  { name: "physical_device_configuration", reason: "Undocumented or physical-only installation, wiring, and firmware configuration are not exposed. Documented writable HVAC preferences are separately available with explicit advanced intent." },
  { name: "legacy_plug_and_ems_controls", reason: "Legacy plug and commercial EMS-specific commands are not exposed for ordinary residential thermostats; support cannot be claimed when the device and verified portal interface do not provide those capabilities." },
] as const;

const definitions = new Map(featureDefinitions.map(definition => [definition.name, definition]));

export function featureReadOnly(name: string): boolean {
  const definition = definitions.get(name);
  if (!definition) throw new UserError("Unsupported thermostat feature. Use the available tool catalog.");
  return definition.readOnly;
}

export function parseFeatureRequest(request: FeatureRequest): FeatureRequest {
  const envelope = z.object({ name: z.string().min(1).max(64), input: z.record(z.string(), z.unknown()) }).strict().safeParse(request);
  if (!envelope.success) throw new UserError("Invalid thermostat feature request.");
  const definition = definitions.get(envelope.data.name);
  if (!definition) throw new UserError("Unsupported thermostat feature. Use the available tool catalog.");
  const parsed = definition.inputSchema.safeParse(envelope.data.input);
  if (!parsed.success) throw new UserError(`Invalid input for ${definition.name}. Check the tool's required fields, allowed values, and bounds.`);
  return { name: definition.name, input: parsed.data as Record<string, unknown> };
}
