import { UserError, type HvacMode, type Thermostat, type ThermostatBackend, type Unit } from "./types.js";

export function fahrenheit(value: number, unit: Unit): number {
  if (!Number.isFinite(value)) throw new UserError("Temperature must be a finite number.");
  return Math.round((unit === "C" ? value * 9 / 5 + 32 : value) * 10) / 10;
}

export class Controller {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly backend: ThermostatBackend, readonly allowWrites = false) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async thermostat(id: string): Promise<Thermostat> {
    const found = (await this.backend.listThermostats()).find(t => t.id === id);
    if (!found) throw new UserError("Thermostat not found. Use list_thermostats to get its exact id.");
    return found;
  }

  private writable(thermostat: Thermostat): void {
    if (!this.allowWrites) throw new UserError("Writes are disabled. Enable changes on your hosted connection page and grant thermostat:write to the client, or start the local server with --allow-writes.");
    if (!thermostat.connected) throw new UserError("Thermostat is offline. No change was sent.");
  }

  list() { return this.serial(async () => ({ backend: this.backend.kind, simulated: this.backend.kind === "demo", thermostats: await this.backend.listThermostats() })); }
  status(id: string) { return this.serial(async () => ({ backend: this.backend.kind, simulated: this.backend.kind === "demo", thermostat: await this.thermostat(id) })); }

  setTemperature(input: { thermostat_id: string; heat?: number; cool?: number; unit: Unit; hours: number }) {
    return this.serial(async () => {
      const before = await this.thermostat(input.thermostat_id);
      this.writable(before);
      if (input.heat === undefined && input.cool === undefined) throw new UserError("Provide heat, cool, or both setpoints with an explicit unit.");
      if (!Number.isInteger(input.hours) || input.hours < 1 || input.hours > 24) throw new UserError("Hold duration must be a whole number of hours from 1 to 24.");
      if (input.unit !== "F" && input.unit !== "C") throw new UserError("Unit must be F or C.");
      const heatF = input.heat === undefined ? before.heatF : fahrenheit(input.heat, input.unit);
      const coolF = input.cool === undefined ? before.coolF : fahrenheit(input.cool, input.unit);
      if (heatF < before.heatMinF || heatF > before.heatMaxF) throw new UserError(`Heat setpoint must be between ${before.heatMinF} and ${before.heatMaxF} F.`);
      if (coolF < before.coolMinF || coolF > before.coolMaxF) throw new UserError(`Cool setpoint must be between ${before.coolMinF} and ${before.coolMaxF} F.`);
      if (coolF - heatF < before.minDeltaF) throw new UserError(`Cool must be at least ${before.minDeltaF} F above heat. Provide both setpoints if needed.`);
      await this.backend.setTemperature(before.id, { heatF, coolF, hours: input.hours });
      const after = await this.thermostat(before.id);
      return { simulated: this.backend.kind === "demo", thermostat_id: before.id, requested: { heatF, coolF, hours: input.hours }, delivery: "accepted", verification: Math.abs(after.heatF - heatF) < 0.11 && Math.abs(after.coolF - coolF) < 0.11 ? "observed" : "pending", thermostat: after };
    });
  }

  setMode(id: string, mode: HvacMode) {
    return this.serial(async () => {
      const before = await this.thermostat(id);
      this.writable(before);
      if (!["off", "heat", "cool", "auto"].includes(mode)) throw new UserError("Unsupported HVAC mode.");
      await this.backend.setMode(id, mode);
      const after = await this.thermostat(id);
      return { simulated: this.backend.kind === "demo", thermostat_id: id, requested: { mode }, delivery: "accepted", verification: after.mode === mode ? "observed" : "pending", thermostat: after };
    });
  }

  resume(id: string) {
    return this.serial(async () => {
      const before = await this.thermostat(id);
      this.writable(before);
      await this.backend.resumeSchedule(id);
      return { simulated: this.backend.kind === "demo", thermostat_id: id, delivery: "accepted", verification: "not_verified", message: "Resume request accepted. Check the ecobee portal for the active schedule.", thermostat: await this.thermostat(id) };
    });
  }
}
