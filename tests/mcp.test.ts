import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { IncomingMessage } from "node:http";
import { Controller } from "../src/controller.js";
import { DemoBackend } from "../src/demo.js";
import { createMcpServer, localRequestAllowed } from "../src/server.js";

const thermostatId = "demo-downstairs";
const cleanups: Array<() => Promise<void>> = [];

async function connect(allowWrites = false) {
  const backend = new DemoBackend();
  const server = createMcpServer(new Controller(backend, allowWrites));
  const client = new Client({ name: "openecobee-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => { await client.close(); await server.close(); });
  return { backend, client };
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
});

describe("MCP protocol", () => {
  it("advertises read/write annotations and explicit input requirements", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(["get_thermostat_status", "list_thermostats", "resume_schedule", "set_hvac_mode", "set_temperature"]);
    for (const tool of tools) {
      const readOnly = ["list_thermostats", "get_thermostat_status"].includes(tool.name);
      expect(tool.annotations).toMatchObject({ readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly });
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
    const temperature = tools.find(tool => tool.name === "set_temperature")!;
    expect(temperature.inputSchema.required).toEqual(expect.arrayContaining(["thermostat_id", "unit"]));
    expect(temperature.inputSchema.required).not.toContain("hours");
    expect(temperature.inputSchema.properties?.hours).toMatchObject({ type: "integer", minimum: 1, maximum: 24 });
    expect(temperature.inputSchema.properties?.unit).toMatchObject({ enum: ["F", "C"] });
  });

  it("roundtrips list and status with explicit simulated results", async () => {
    const { client } = await connect();
    const list = await client.callTool({ name: "list_thermostats", arguments: {} });
    expect(list.isError).not.toBe(true);
    expect(list.structuredContent).toMatchObject({ backend: "demo", simulated: true, thermostats: [{ id: thermostatId, temperatureF: 72 }] });
    const status = await client.callTool({ name: "get_thermostat_status", arguments: { thermostat_id: thermostatId } });
    expect(status.structuredContent).toMatchObject({ backend: "demo", simulated: true, thermostat: { id: thermostatId, heatF: 68, coolF: 75 } });
  });

  it.each([
    ["list_thermostats", { unexpected: true }],
    ["get_thermostat_status", { thermostat_id: thermostatId, unexpected: true }],
    ["set_temperature", { thermostat_id: thermostatId, cool: 77, hours: 2 }],
    ["set_temperature", { thermostat_id: thermostatId, cool: 77, unit: "F" }],
    ["set_temperature", { thermostat_id: thermostatId, cool: 77, unit: "F", hours: 2, unexpected: true }],
    ["set_hvac_mode", { thermostat_id: thermostatId, mode: "turbo" }],
  ] as const)("rejects invalid %s arguments before mutating state", async (name, args) => {
    const { backend, client } = await connect(true);
    const before = await backend.listThermostats();
    const temperature = vi.spyOn(backend, "setTemperature");
    const mode = vi.spyOn(backend, "setMode");
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(temperature).not.toHaveBeenCalled();
    expect(mode).not.toHaveBeenCalled();
    expect(await backend.listThermostats()).toEqual(before);
  });

  it("returns a tool error for writes while the controller is read-only", async () => {
    const { backend, client } = await connect();
    const write = vi.spyOn(backend, "setTemperature");
    const result = await client.callTool({ name: "set_temperature", arguments: { thermostat_id: thermostatId, cool: 77, unit: "F", hours: 2 } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining("Writes are disabled") })]));
    expect(write).not.toHaveBeenCalled();
  });

  it("roundtrips authorized temperature, mode, and resume operations", async () => {
    const { client } = await connect(true);
    const temperature = await client.callTool({ name: "set_temperature", arguments: { thermostat_id: thermostatId, cool: 77, unit: "F", hours: 2 } });
    expect(temperature.structuredContent).toMatchObject({ simulated: true, delivery: "accepted", verification: "observed", thermostat: { heatF: 68, coolF: 77 } });
    const mode = await client.callTool({ name: "set_hvac_mode", arguments: { thermostat_id: thermostatId, mode: "cool" } });
    expect(mode.structuredContent).toMatchObject({ delivery: "accepted", verification: "observed", thermostat: { mode: "cool" } });
    const resume = await client.callTool({ name: "resume_schedule", arguments: { thermostat_id: thermostatId } });
    expect(resume.structuredContent).toMatchObject({ delivery: "accepted", verification: "not_verified", thermostat: { heatF: 68, coolF: 75 } });
  });

  it("reports unknown ids as tool errors", async () => {
    const { client } = await connect(true);
    const result = await client.callTool({ name: "get_thermostat_status", arguments: { thermostat_id: "missing" } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining("Thermostat not found") })]));
  });

  it("accepts an explicit indefinite cooling hold without inventing hours", async () => {
    const { client } = await connect(true);
    await client.callTool({ name: "set_hvac_mode", arguments: { thermostat_id: thermostatId, mode: "cool" } });
    const result = await client.callTool({ name: "set_temperature", arguments: { thermostat_id: thermostatId, cool: 65, unit: "F", hold_type: "indefinite" } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ requested: { coolF: 65, hold_type: "indefinite", hold_description: "until changed" }, thermostat: { mode: "cool", heatF: 68, coolF: 65 } });
    expect((result.structuredContent as { requested: Record<string, unknown> }).requested).not.toHaveProperty("hours");
  });
});

describe("local HTTP request validation", () => {
  const port = 19876;
  function request(host?: string, origin?: string) {
    return { headers: { host, origin } } as IncomingMessage;
  }

  it.each([
    ["127.0.0.1:19876", undefined],
    ["localhost:19876", undefined],
    ["127.0.0.1:19876", "http://127.0.0.1:19876"],
    ["localhost:19876", "http://localhost:19876"],
  ])("accepts loopback host %s and origin %s", (host, origin) => {
    expect(localRequestAllowed(request(host, origin), port)).toBe(true);
  });

  it.each([
    [undefined, undefined],
    ["evil.example:19876", undefined],
    ["127.0.0.1:19877", undefined],
    ["localhost.evil.example:19876", undefined],
    ["127.0.0.1:19876", "https://evil.example"],
    ["localhost:19876", "null"],
    ["localhost:19876", "http://localhost:19877"],
  ])("rejects host %s and origin %s", (host, origin) => {
    expect(localRequestAllowed(request(host, origin), port)).toBe(false);
  });
});
