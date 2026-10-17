import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Controller } from "./controller.js";
import { UserError } from "./types.js";
import type { FeatureRequest } from "./feature-types.js";
import { advancedSettingsKeys, featureDefinitions, unsupportedFeatures, writableSettingsKeys } from "./features.js";

const id = z.string().min(1).max(128).describe("Exact thermostat id returned by list_thermostats.");
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const write = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

function handler<T>(fn: () => Promise<T>) {
  return fn().then(data => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data as Record<string, unknown> })).catch(error => ({ isError: true, content: [{ type: "text" as const, text: error instanceof UserError ? error.message : "Operation failed. Reconnect ecobee from the hosted connection page, or check local sign-in with openecobee status. If a change was sent, verify it in ecobee before retrying." }] }));
}

export interface ThermostatControls {
  list(): Promise<unknown>;
  status(id: string): Promise<unknown>;
  setTemperature(input: Parameters<Controller["setTemperature"]>[0]): Promise<unknown>;
  setMode(id: string, mode: Parameters<Controller["setMode"]>[1]): Promise<unknown>;
  resume(id: string): Promise<unknown>;
  feature?(request: FeatureRequest): Promise<unknown>;
}

export function createMcpServer(controller: ThermostatControls): McpServer {
  const server = new McpServer({ name: "openecobee", version: "0.2.0" }, { instructions: "Control the user's ecobee. Consult get_capabilities for verified coverage and gaps before promising device-specific or individual eco+ controls. Eco+ is separate from HVAC mode. Always list thermostats before selecting an id. Use explicit Fahrenheit or Celsius units. Ask for a hold duration if the user did not specify one; never invent a 24-hour hold. Use an indefinite hold when the user explicitly says until changed. Explain requested thermostat changes and honor client approval controls. Never ask for passwords, MFA codes, cookies, or tokens in chat. Demo responses are simulated. Delivery accepted does not establish physical HVAC behavior; verification pending means readback has not matched. Temperature verification covers setpoints only; use get_events to verify the requested hold duration." });
  server.registerTool("list_thermostats", { description: "List thermostats and their current temperatures, setpoints, limits, and connection state.", inputSchema: z.object({}).strict(), annotations: read }, () => handler(() => controller.list()));
  server.registerTool("get_thermostat_status", { description: "Read a thermostat's current status. All fields ending F are Fahrenheit. temperatureF is ecobee's displayed temperature and can be humidity adjusted; get_energy_status reports displayed versus unadjusted temperature and automation details.", inputSchema: z.object({ thermostat_id: id }).strict(), annotations: read }, ({ thermostat_id }) => handler(() => controller.status(thermostat_id)));
  server.registerTool("set_temperature", { description: "Set a temperature hold with explicit F/C units. Choose hold_type hours with 1–24 hours, indefinite only when the user says until changed, or next_transition for the next scheduled change. Ask if duration is unspecified; never invent 24 hours. Keeps omitted setpoints. Requires write permission. When changing HVAC mode, confirm its readback before setting a temperature.", inputSchema: z.object({ thermostat_id: id, heat: z.number().finite().optional(), cool: z.number().finite().optional(), unit: z.enum(["F", "C"]), hold_type: z.enum(["hours", "indefinite", "next_transition"]).optional(), hours: z.number().int().min(1).max(24).optional() }).strict(), annotations: write }, input => handler(() => controller.setTemperature(input)));
  server.registerTool("set_hvac_mode", { description: "Change thermostat HVAC mode to off, heat, cool, or auto. Requires account write permission and the client write scope when hosted, or server --allow-writes locally.", inputSchema: z.object({ thermostat_id: id, mode: z.enum(["off", "heat", "cool", "auto"]) }).strict(), annotations: write }, ({ thermostat_id, mode }) => handler(() => controller.setMode(thermostat_id, mode)));
  server.registerTool("resume_schedule", { description: "Resume the thermostat's programmed schedule from a hold. Requires account write permission and the client write scope when hosted, or server --allow-writes locally.", inputSchema: z.object({ thermostat_id: id }).strict(), annotations: write }, ({ thermostat_id }) => handler(() => controller.resume(thermostat_id)));
  server.registerTool("get_capabilities", { description: "List server thermostat operations, writable settings, and verified coverage gaps. Device support is checked when an operation runs. Check this before promising eco+ or device-specific controls. Unavailable or unverified capabilities are not supported just because a related setting exists.", inputSchema: z.object({}).strict(), annotations: read }, () => handler(async () => ({ tools: ["list_thermostats", "get_thermostat_status", "set_temperature", "set_hvac_mode", "resume_schedule", ...featureDefinitions.map(feature => feature.name)], writable_settings: writableSettingsKeys, advanced_settings: advancedSettingsKeys, unavailable: unsupportedFeatures })));
  for (const feature of featureDefinitions) {
    server.registerTool(feature.name, { description: feature.description, inputSchema: feature.inputSchema, annotations: feature.readOnly ? read : write }, input => handler(async () => {
      if (!controller.feature) throw new UserError("Extended thermostat features are unavailable on this backend.");
      return controller.feature({ name: feature.name, input: input as Record<string, unknown> });
    }));
  }
  return server;
}

