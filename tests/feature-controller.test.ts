import { describe, expect, it, vi } from "vitest";
import { Controller } from "../src/controller.js";
import type { FeatureRequest } from "../src/feature-types.js";
import { UserError, type Thermostat, type ThermostatBackend } from "../src/types.js";

const ownedId = "123456789012";
const otherId = "999999999999";

function setup(options: { allowWrites?: boolean; connected?: boolean; extendedBackend?: boolean } = {}) {
  const state: Thermostat = {
    id: ownedId, name: "Test thermostat", temperatureF: 72, humidity: 45, mode: "auto", heatF: 68, coolF: 75,
    connected: options.connected ?? true, heatMinF: 45, heatMaxF: 79, coolMinF: 65, coolMaxF: 92, minDeltaF: 5, equipment: "",
  };
  const executeFeature = vi.fn(async (request: FeatureRequest) => ({ operation: request.name, accepted: true }));
  const backend: ThermostatBackend = {
    kind: "browser",
    listThermostats: vi.fn(async () => [structuredClone(state)]),
    setTemperature: vi.fn(async () => {}),
    setMode: vi.fn(async () => {}),
    resumeSchedule: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...(options.extendedBackend === false ? {} : { executeFeature }),
  };
  return { state, backend, executeFeature, controller: new Controller(backend, options.allowWrites ?? false) };
}

const writes: FeatureRequest[] = [
  { name: "set_eco_plus", input: { thermostat_id: ownedId, enabled: false } },
  { name: "update_settings", input: { thermostat_id: ownedId, patch: { fanMinOnTime: 15 } } },
  { name: "set_fan", input: { thermostat_id: ownedId, mode: "on", hold_type: "indefinite" } },
];

describe("extended thermostat controller permissions and ownership", () => {
  it("allows an energy read on a read-only server even when the thermostat is offline", async () => {
    const { controller, executeFeature, state } = setup({ connected: false });
    const before = structuredClone(state);
    const request = { name: "get_energy_status", input: { thermostat_id: ownedId } };
    const result = await controller.feature(request);
    expect(executeFeature).toHaveBeenCalledExactlyOnceWith(request);
    expect(result).toMatchObject({ backend: "browser", simulated: false, thermostat_id: ownedId, operation: "get_energy_status", data: { accepted: true } });
    expect(state).toEqual(before);
  });

  it.each(writes)("blocks $name without write permission before dispatching to the backend", async request => {
    const { controller, executeFeature, state } = setup();
    const before = structuredClone(state);
    await expect(controller.feature(request)).rejects.toThrow("Writes are disabled");
    expect(executeFeature).not.toHaveBeenCalled();
    expect(state).toEqual(before);
  });

  it.each(writes)("blocks $name while offline even with write permission", async request => {
    const { controller, executeFeature, state } = setup({ allowWrites: true, connected: false });
    const before = structuredClone(state);
    await expect(controller.feature(request)).rejects.toThrow("offline");
    expect(executeFeature).not.toHaveBeenCalled();
    expect(state).toEqual(before);
  });

  it.each(["get_energy_status", "set_eco_plus"])("does not dispatch %s for another thermostat", async name => {
    const { controller, executeFeature } = setup({ allowWrites: true });
    const request = { name, input: { thermostat_id: otherId, ...(name === "set_eco_plus" ? { enabled: true } : {}) } };
    await expect(controller.feature(request)).rejects.toThrow("Thermostat not found");
    expect(executeFeature).not.toHaveBeenCalled();
  });

  it("preserves the verified target and normalizes defaults before an authorized settings write", async () => {
    const { controller, executeFeature } = setup({ allowWrites: true });
    const result = await controller.feature({ name: "update_settings", input: { thermostat_id: ownedId, patch: { fanMinOnTime: 15 } } });
    expect(executeFeature).toHaveBeenCalledExactlyOnceWith({ name: "update_settings", input: { thermostat_id: ownedId, patch: { fanMinOnTime: 15 }, allow_advanced_settings: false } });
    expect(result.thermostat_id).toBe(ownedId);
  });

  it("fails without falling back to another write when extended operations are unavailable", async () => {
    const { controller, backend, executeFeature } = setup({ allowWrites: true, extendedBackend: false });
    await expect(controller.feature(writes[0])).rejects.toThrow("does not support extended thermostat features");
    expect(executeFeature).not.toHaveBeenCalled();
    expect(backend.setTemperature).not.toHaveBeenCalled();
    expect(backend.setMode).not.toHaveBeenCalled();
    expect(backend.resumeSchedule).not.toHaveBeenCalled();
  });
});

describe("extended controller input boundary", () => {
  it("rejects an unregistered operation before querying household state", async () => {
    const { controller, backend, executeFeature } = setup({ allowWrites: true });
    await expect(controller.feature({ name: "raw_request", input: { thermostat_id: ownedId, url: "https://attacker.example" } })).rejects.toThrow(UserError);
    expect(backend.listThermostats).not.toHaveBeenCalled();
    expect(executeFeature).not.toHaveBeenCalled();
  });

  it.each([
    { name: "get_energy_status", input: { thermostat_id: `${ownedId},${otherId}` } },
    { name: "get_energy_status", input: { thermostat_id: ownedId, user_id: "other-account" } },
    { name: "set_eco_plus", input: { thermostat_id: ownedId, enabled: true, script: "arbitrary code" } },
    { name: "update_settings", input: { thermostat_id: ownedId, patch: { accessCode: "1234" } } },
    { name: "update_settings", input: { thermostat_id: ownedId, patch: { fanMinOnTime: 61 } } },
    { name: "update_settings", input: { thermostat_id: ownedId, patch: { fanMinOnTime: -1 } } },
    { name: "update_settings", input: { thermostat_id: ownedId, patch: { fanMinOnTime: "15" } } },
    { name: "update_settings", input: { thermostat_id: ownedId, patch: { compressorProtectionMinTime: 1 }, allow_advanced_settings: true } },
    { name: "set_fan", input: { thermostat_id: ownedId, mode: "on", hold_type: "indefinite", hours: 2 } },
    { name: "send_message", input: { thermostat_id: ownedId, text: "x".repeat(501) } },
  ])("rejects unsafe $name parameters without backend access", async request => {
    const { controller, backend, executeFeature, state } = setup({ allowWrites: true });
    const before = structuredClone(state);
    await expect(controller.feature(request)).rejects.toThrow(UserError);
    expect(backend.listThermostats).not.toHaveBeenCalled();
    expect(executeFeature).not.toHaveBeenCalled();
    expect(state).toEqual(before);
  });

  it("requires the explicit advanced-settings flag before dispatching an installer setting", async () => {
    const { controller, executeFeature } = setup({ allowWrites: true });
    const input = { thermostat_id: ownedId, patch: { heatCoolMinDelta: 50 } };
    await expect(controller.feature({ name: "update_settings", input })).rejects.toThrow(UserError);
    expect(executeFeature).not.toHaveBeenCalled();
    await controller.feature({ name: "update_settings", input: { ...input, allow_advanced_settings: true } });
    expect(executeFeature).toHaveBeenCalledExactlyOnceWith({ name: "update_settings", input: { ...input, allow_advanced_settings: true } });
  });

  it("bounds report requests before performing a household read", async () => {
    const { controller, backend, executeFeature } = setup();
    await expect(controller.feature({ name: "get_runtime_report", input: { thermostat_id: ownedId, start_date: "2026-09-01", end_date: "2026-10-17" } })).rejects.toThrow(UserError);
    expect(backend.listThermostats).not.toHaveBeenCalled();
    expect(executeFeature).not.toHaveBeenCalled();
  });

  it("rejects extra envelope fields rather than exposing an arbitrary backend method", async () => {
    const { controller, executeFeature } = setup({ allowWrites: true });
    const request = { name: "set_eco_plus", input: { thermostat_id: ownedId, enabled: true }, method: "deleteAccount" };
    await expect(controller.feature(request)).rejects.toThrow("Invalid thermostat feature request");
    expect(executeFeature).not.toHaveBeenCalled();
  });
});

describe("extended controller serialization", () => {
  it("finishes one feature operation before dispatching the next", async () => {
    const { controller, executeFeature } = setup({ allowWrites: true });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    executeFeature.mockImplementationOnce(async request => { await gate; return { operation: request.name, accepted: true }; });
    const first = controller.feature(writes[0]);
    const second = controller.feature(writes[1]);
    await vi.waitFor(() => expect(executeFeature).toHaveBeenCalledTimes(1));
    expect(executeFeature.mock.calls[0][0].name).toBe("set_eco_plus");
    release();
    await Promise.all([first, second]);
    expect(executeFeature.mock.calls.map(([request]) => request.name)).toEqual(["set_eco_plus", "update_settings"]);
  });

  it("continues serving authorized reads after rejecting an unsafe feature", async () => {
    const { controller, executeFeature } = setup();
    const invalid = controller.feature({ name: "set_eco_plus", input: { thermostat_id: ownedId, enabled: true } });
    const read = controller.feature({ name: "get_energy_status", input: { thermostat_id: ownedId } });
    await expect(invalid).rejects.toThrow("Writes are disabled");
    await expect(read).resolves.toMatchObject({ thermostat_id: ownedId, operation: "get_energy_status" });
    expect(executeFeature).toHaveBeenCalledExactlyOnceWith({ name: "get_energy_status", input: { thermostat_id: ownedId } });
  });
});
