import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Controller } from "./controller.js";
import { UserError } from "./types.js";

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
}

export function createMcpServer(controller: ThermostatControls): McpServer {
  const server = new McpServer({ name: "openecobee", version: "0.1.0" }, { instructions: "Control the user's ecobee. Always list thermostats before selecting an id. Use explicit Fahrenheit or Celsius units. Temperature changes are timed holds. Explain requested thermostat changes and honor client approval controls. Never ask for passwords, MFA codes, cookies, or tokens in chat. Demo responses are simulated. Delivery accepted does not establish physical HVAC behavior; verification pending means readback has not matched." });
  server.registerTool("list_thermostats", { description: "List thermostats and their current temperatures, setpoints, limits, and connection state.", inputSchema: z.object({}).strict(), annotations: read }, () => handler(() => controller.list()));
  server.registerTool("get_thermostat_status", { description: "Read a thermostat's current status. All fields ending F are Fahrenheit.", inputSchema: z.object({ thermostat_id: id }).strict(), annotations: read }, ({ thermostat_id }) => handler(() => controller.status(thermostat_id)));
  server.registerTool("set_temperature", { description: "Set a 1–24 hour temperature hold. Supply heat, cool, or both with explicit F/C units. Keeps any omitted setpoint. Requires account write permission and the client write scope when hosted, or server --allow-writes locally.", inputSchema: z.object({ thermostat_id: id, heat: z.number().finite().optional(), cool: z.number().finite().optional(), unit: z.enum(["F", "C"]), hours: z.number().int().min(1).max(24) }).strict(), annotations: write }, input => handler(() => controller.setTemperature(input)));
  server.registerTool("set_hvac_mode", { description: "Change thermostat HVAC mode to off, heat, cool, or auto. Requires account write permission and the client write scope when hosted, or server --allow-writes locally.", inputSchema: z.object({ thermostat_id: id, mode: z.enum(["off", "heat", "cool", "auto"]) }).strict(), annotations: write }, ({ thermostat_id, mode }) => handler(() => controller.setMode(thermostat_id, mode)));
  server.registerTool("resume_schedule", { description: "Resume the thermostat's programmed schedule from a hold. Requires account write permission and the client write scope when hosted, or server --allow-writes locally.", inputSchema: z.object({ thermostat_id: id }).strict(), annotations: write }, ({ thermostat_id }) => handler(() => controller.resume(thermostat_id)));
  return server;
}

