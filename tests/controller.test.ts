import { describe, expect, it, vi } from "vitest";
import { Controller, fahrenheit } from "../src/controller.js";
import { DemoBackend } from "../src/demo.js";
import { UserError, type Thermostat, type ThermostatBackend } from "../src/types.js";

const thermostatId = "demo-downstairs";

function setup(allowWrites = true) {
  const backend = new DemoBackend();
  return { backend, controller: new Controller(backend, allowWrites) };
}

describe("Controller", () => {
  it("blocks all writes by default without changing the backend", async () => {
    const { backend, controller } = setup(false);
    const before = await backend.listThermostats();
    const temperature = vi.spyOn(backend, "setTemperature");
    const mode = vi.spyOn(backend, "setMode");
    const resume = vi.spyOn(backend, "resumeSchedule");

    await expect(controller.setTemperature({ thermostat_id: thermostatId, heat: 69, unit: "F", hours: 2 })).rejects.toThrow("Writes are disabled");
    await expect(controller.setMode(thermostatId, "heat")).rejects.toThrow("Writes are disabled");
    await expect(controller.resume(thermostatId)).rejects.toThrow("Writes are disabled");

    expect(temperature).not.toHaveBeenCalled();
    expect(mode).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(await backend.listThermostats()).toEqual(before);
  });

  it("converts Celsius setpoints, preserves the duration, and observes readback", async () => {
    const { backend, controller } = setup();
    const write = vi.spyOn(backend, "setTemperature");
    const result = await controller.setTemperature({ thermostat_id: thermostatId, heat: 19, cool: 24, unit: "C", hours: 3 });

    expect(write).toHaveBeenCalledWith(thermostatId, { heatF: 66.2, coolF: 75.2, holdType: "hours", hours: 3 });
    expect(result).toMatchObject({ simulated: true, delivery: "accepted", verification: "observed", thermostat: { heatF: 66.2, coolF: 75.2 } });
  });

  it("keeps the omitted setpoint", async () => {
    const { controller } = setup();
    const result = await controller.setTemperature({ thermostat_id: thermostatId, cool: 77, unit: "F", hours: 1 });
    expect(result.requested).toEqual({ heatF: 68, coolF: 77, hold_type: "hours", hold_description: "for 1 hour", hours: 1 });
  });

  it.each([
    ["indefinite", "until changed"],
    ["next_transition", "until the next scheduled change"],
  ] as const)("sends a %s hold without inventing an hourly duration", async (holdType, description) => {
    const { backend, controller } = setup();
    const write = vi.spyOn(backend, "setTemperature");
    const result = await controller.setTemperature({ thermostat_id: thermostatId, cool: 77, unit: "F", hold_type: holdType });
    expect(write).toHaveBeenCalledExactlyOnceWith(thermostatId, { heatF: 68, coolF: 77, holdType });
    expect(result.requested).toEqual({ heatF: 68, coolF: 77, hold_type: holdType, hold_description: description });
    expect(result.requested).not.toHaveProperty("hours");
    expect(result.verification).toBe("observed");
  });

  it("normalizes an explicit timed hold", async () => {
    const { backend, controller } = setup();
    const write = vi.spyOn(backend, "setTemperature");
    const result = await controller.setTemperature({ thermostat_id: thermostatId, cool: 77, unit: "F", hold_type: "hours", hours: 4 });
    expect(write).toHaveBeenCalledExactlyOnceWith(thermostatId, { heatF: 68, coolF: 77, holdType: "hours", hours: 4 });
    expect(result.requested).toMatchObject({ hold_type: "hours", hold_description: "for 4 hours", hours: 4 });
  });

  it.each([undefined, "hours"] as const)("requires an hourly duration for hold type %s", async hold_type => {
    const { backend, controller } = setup();
    const write = vi.spyOn(backend, "setTemperature");
    await expect(controller.setTemperature({ thermostat_id: thermostatId, cool: 77, unit: "F", hold_type })).rejects.toThrow("whole number of hours from 1 to 24");
    expect(write).not.toHaveBeenCalled();
  });

  it.each(["indefinite", "next_transition"] as const)("rejects a contradictory duration on a %s hold", async hold_type => {
    const { backend, controller } = setup();
    const write = vi.spyOn(backend, "setTemperature");
    await expect(controller.setTemperature({ thermostat_id: thermostatId, cool: 77, unit: "F", hold_type, hours: 24 })).rejects.toThrow("Hours must be omitted");
    expect(write).not.toHaveBeenCalled();
  });

  it("rejects an unsupported hold type without a write", async () => {
    const { backend, controller } = setup();
    const write = vi.spyOn(backend, "setTemperature");
    await expect(controller.setTemperature({ thermostat_id: thermostatId, cool: 77, unit: "F", hold_type: "forever" as never })).rejects.toThrow("Hold type must be");
    expect(write).not.toHaveBeenCalled();
  });

  it("allows 65 F cooling in fresh Cool mode while preserving the inactive 67 F heat setpoint", async () => {
    const { backend, controller } = setup();
    await backend.setTemperature(thermostatId, { heatF: 67, coolF: 72, hours: 2 });
    await backend.setMode(thermostatId, "cool");
    const write = vi.spyOn(backend, "setTemperature");
    const result = await controller.setTemperature({ thermostat_id: thermostatId, cool: 65, unit: "F", hold_type: "indefinite" });
    expect(write).toHaveBeenCalledExactlyOnceWith(thermostatId, { heatF: 67, coolF: 65, holdType: "indefinite" });
    expect(result).toMatchObject({ verification: "observed", requested: { heatF: 67, coolF: 65, hold_type: "indefinite" }, thermostat: { mode: "cool", heatF: 67, coolF: 65 } });
  });

  it("still rejects a 65 F cooling setpoint against 67 F heat in Auto mode", async () => {
    const { backend, controller } = setup();
    await backend.setTemperature(thermostatId, { heatF: 67, coolF: 72, hours: 2 });
    const before = await backend.listThermostats();
    const write = vi.spyOn(backend, "setTemperature");
    await expect(controller.setTemperature({ thermostat_id: thermostatId, cool: 65, unit: "F", hold_type: "indefinite" })).rejects.toThrow("In Auto mode");
    expect(write).not.toHaveBeenCalled();
    expect(await backend.listThermostats()).toEqual(before);
  });

  it.each([0, 25, 1.5, Number.NaN])("rejects invalid duration %s before sending a change", async hours => {
    const { backend, controller } = setup();
    const write = vi.spyOn(backend, "setTemperature");
    await expect(controller.setTemperature({ thermostat_id: thermostatId, cool: 77, unit: "F", hours })).rejects.toThrow("whole number of hours from 1 to 24");
    expect(write).not.toHaveBeenCalled();
    expect((await backend.listThermostats())[0]).toMatchObject({ heatF: 68, coolF: 75 });
  });

  it.each([1, 24])("accepts duration boundary %s", async hours => {
    const { controller } = setup();
    const result = await controller.setTemperature({ thermostat_id: thermostatId, cool: 77, unit: "F", hours });
    expect(result.requested.hours).toBe(hours);
  });

  it.each([
    [{ heat: 44 }, "Heat setpoint must be between"],
    [{ heat: 80 }, "Heat setpoint must be between"],
    [{ cool: 64 }, "Cool setpoint must be between"],
    [{ cool: 93 }, "Cool setpoint must be between"],
    [{ heat: 71, cool: 75 }, "at least 5 F above heat"],
    [{}, "Provide heat, cool, or both"],
    [{ heat: Number.POSITIVE_INFINITY }, "finite number"],
  ] as const)("rejects unsafe setpoints %j without mutation", async (setpoints, message) => {
    const { backend, controller } = setup();
    const before = await backend.listThermostats();
    const write = vi.spyOn(backend, "setTemperature");
    await expect(controller.setTemperature({ thermostat_id: thermostatId, ...setpoints, unit: "F", hours: 2 })).rejects.toThrow(message);
    expect(write).not.toHaveBeenCalled();
    expect(await backend.listThermostats()).toEqual(before);
  });

  it("accepts the minimum device deadband exactly", async () => {
    const { controller } = setup();
    const result = await controller.setTemperature({ thermostat_id: thermostatId, heat: 70, cool: 75, unit: "F", hours: 2 });
    expect(result.verification).toBe("observed");
  });

  it("rejects unknown thermostat ids for reads and writes", async () => {
    const { backend, controller } = setup();
    const write = vi.spyOn(backend, "setMode");
    await expect(controller.status("missing")).rejects.toBeInstanceOf(UserError);
    await expect(controller.setMode("missing", "off")).rejects.toThrow("Thermostat not found");
    await expect(controller.setTemperature({ thermostat_id: "missing", heat: 69, unit: "F", hours: 2 })).rejects.toThrow("Thermostat not found");
    await expect(controller.resume("missing")).rejects.toThrow("Thermostat not found");
    expect(write).not.toHaveBeenCalled();
  });

  it("rejects writes to offline thermostats", async () => {
    const { backend, controller } = setup();
    const [thermostat] = await backend.listThermostats();
    vi.spyOn(backend, "listThermostats").mockResolvedValue([{ ...thermostat, connected: false }]);
    const temperature = vi.spyOn(backend, "setTemperature");
    const mode = vi.spyOn(backend, "setMode");
    const resume = vi.spyOn(backend, "resumeSchedule");

    await expect(controller.setTemperature({ thermostat_id: thermostatId, cool: 77, unit: "F", hours: 2 })).rejects.toThrow("offline");
    await expect(controller.setMode(thermostatId, "off")).rejects.toThrow("offline");
    await expect(controller.resume(thermostatId)).rejects.toThrow("offline");
    expect(temperature).not.toHaveBeenCalled();
    expect(mode).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it("reports pending when an accepted write is absent from readback", async () => {
    const state = (await new DemoBackend().listThermostats())[0];
    const backend: ThermostatBackend = {
      kind: "browser",
      listThermostats: async () => [structuredClone(state)],
      setTemperature: vi.fn(async () => {}),
      setMode: vi.fn(async () => {}),
      resumeSchedule: vi.fn(async () => {}),
      close: async () => {},
    };
    const controller = new Controller(backend, true);

    const temperature = await controller.setTemperature({ thermostat_id: thermostatId, cool: 77, unit: "F", hours: 2 });
    const mode = await controller.setMode(thermostatId, "heat");
    expect(temperature).toMatchObject({ simulated: false, delivery: "accepted", verification: "pending", thermostat: { coolF: 75 } });
    expect(mode).toMatchObject({ simulated: false, delivery: "accepted", verification: "pending", thermostat: { mode: "auto" } });
  });

  it("does not claim to verify resumption of a schedule", async () => {
    const { controller } = setup();
    await controller.setTemperature({ thermostat_id: thermostatId, cool: 77, unit: "F", hours: 2 });
    const result = await controller.resume(thermostatId);
    expect(result).toMatchObject({ delivery: "accepted", verification: "not_verified", thermostat: { heatF: 68, coolF: 75 } });
  });

  it("serializes writes and their readback before starting the next write", async () => {
    const { backend, controller } = setup();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const setMode = backend.setMode.bind(backend);
    const setTemperature = backend.setTemperature.bind(backend);
    vi.spyOn(backend, "setMode").mockImplementation(async (id, mode) => {
      events.push("mode:start");
      await gate;
      await setMode(id, mode);
      events.push("mode:end");
    });
    vi.spyOn(backend, "setTemperature").mockImplementation(async (id, hold) => {
      events.push("temperature:start");
      await setTemperature(id, hold);
    });

    const first = controller.setMode(thermostatId, "heat");
    const second = controller.setTemperature({ thermostat_id: thermostatId, heat: 69, unit: "F", hours: 2 });
    await vi.waitFor(() => expect(events).toEqual(["mode:start"]));
    releaseFirst();
    const [mode, temperature] = await Promise.all([first, second]);
    expect(events).toEqual(["mode:start", "mode:end", "temperature:start"]);
    expect(mode.thermostat.heatF).toBe(68);
    expect(temperature.thermostat).toMatchObject({ mode: "heat", heatF: 69 });
  });

  it("continues the queue after a rejected operation", async () => {
    const { controller } = setup();
    const rejected = controller.setTemperature({ thermostat_id: thermostatId, heat: 90, unit: "F", hours: 2 });
    const next = controller.setMode(thermostatId, "cool");
    await expect(rejected).rejects.toThrow("Heat setpoint");
    await expect(next).resolves.toMatchObject({ verification: "observed", thermostat: { mode: "cool" } });
  });
});

describe("temperature conversion", () => {
  it.each([[20, "C", 68], [21, "C", 69.8], [72.34, "F", 72.3]] as const)("converts %s %s to %s F", (value, unit, expected) => {
    expect(fahrenheit(value, unit)).toBe(expected);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects non-finite value %s", value => {
    expect(() => fahrenheit(value, "F")).toThrow(UserError);
  });
});

describe("DemoBackend isolation", () => {
  it("returns independent snapshots and keeps separate demo instances isolated", async () => {
    const first = new DemoBackend();
    const second = new DemoBackend();
    const [snapshot] = await first.listThermostats();
    snapshot.name = "Changed outside backend";
    snapshot.heatF = 1;
    await first.setMode(thermostatId, "off");
    expect((await first.listThermostats())[0]).toMatchObject({ name: "Downstairs (Demo)", heatF: 68, mode: "off" });
    expect((await second.listThermostats())[0]).toMatchObject({ heatF: 68, mode: "auto" });
  });

  it("rejects unknown ids directly without changing its thermostat", async () => {
    const backend = new DemoBackend();
    const before: Thermostat[] = await backend.listThermostats();
    await expect(backend.setTemperature("missing", { heatF: 69, coolF: 75, hours: 2 })).rejects.toThrow(UserError);
    await expect(backend.setMode("missing", "off")).rejects.toThrow(UserError);
    await expect(backend.resumeSchedule("missing")).rejects.toThrow(UserError);
    expect(await backend.listThermostats()).toEqual(before);
  });
});
