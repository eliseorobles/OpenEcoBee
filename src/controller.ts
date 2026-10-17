import { UserError, type HvacMode, type TemperatureHold, type Thermostat, type ThermostatBackend, type Unit } from "./types.js";
import type { FeatureRequest } from "./feature-types.js";
import { featureReadOnly, parseFeatureRequest } from "./features.js";

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

  private async readAfterWrite(id: string): Promise<Thermostat> {
    try { return await this.thermostat(id); }
    catch { throw new UserError("Ecobee accepted the change, but its current state could not be read. Check the thermostat before sending another change; this request was not retried."); }
  }

  private writable(thermostat: Thermostat): void {
    if (!this.allowWrites) throw new UserError("Writes are disabled. Enable changes on your hosted connection page and grant thermostat:write to the client, or start the local server with --allow-writes.");
    if (!thermostat.connected) throw new UserError("Thermostat is offline. No change was sent.");
  }

  list() { return this.serial(async () => ({ backend: this.backend.kind, simulated: this.backend.kind === "demo", thermostats: await this.backend.listThermostats() })); }
  status(id: string) { return this.serial(async () => ({ backend: this.backend.kind, simulated: this.backend.kind === "demo", thermostat: await this.thermostat(id) })); }

  feature(request: FeatureRequest) {
    return this.serial(async () => {
      const parsed = parseFeatureRequest(request);
      const target = await this.thermostat(String(parsed.input.thermostat_id));
      if (!featureReadOnly(parsed.name)) this.writable(target);
      if (!this.backend.executeFeature) throw new UserError("This backend does not support extended thermostat features.");
      return { backend: this.backend.kind, simulated: this.backend.kind === "demo", operation: parsed.name, thermostat_id: target.id, data: await this.backend.executeFeature(parsed) };
    });
  }

  setTemperature(input: { thermostat_id: string; heat?: number; cool?: number; unit: Unit; hold_type?: "hours" | "indefinite" | "next_transition"; hours?: number }) {
    return this.serial(async () => {
      const before = await this.thermostat(input.thermostat_id);
      this.writable(before);
      if (input.heat === undefined && input.cool === undefined) throw new UserError("Provide heat, cool, or both setpoints with an explicit unit.");
      const holdType = input.hold_type ?? "hours";
      if (!["hours", "indefinite", "next_transition"].includes(holdType)) throw new UserError("Hold type must be hours, indefinite, or next_transition.");
      if (holdType === "hours") {
        if (input.hours === undefined || !Number.isInteger(input.hours) || input.hours < 1 || input.hours > 24) throw new UserError("Hold duration must be a whole number of hours from 1 to 24.");
      } else if (input.hours !== undefined) {
        throw new UserError("Hours must be omitted for indefinite and next_transition holds.");
      }
      if (input.unit !== "F" && input.unit !== "C") throw new UserError("Unit must be F or C.");
      const heatF = input.heat === undefined ? before.heatF : fahrenheit(input.heat, input.unit);
      const coolF = input.cool === undefined ? before.coolF : fahrenheit(input.cool, input.unit);
      if (heatF < before.heatMinF || heatF > before.heatMaxF) throw new UserError(`Heat setpoint must be between ${before.heatMinF} and ${before.heatMaxF} F.`);
      if (coolF < before.coolMinF || coolF > before.coolMaxF) throw new UserError(`Cool setpoint must be between ${before.coolMinF} and ${before.coolMaxF} F.`);
      if (before.mode === "auto" && coolF - heatF < before.minDeltaF) throw new UserError(`In Auto mode, cool must be at least ${before.minDeltaF} F above heat. Provide both setpoints if needed.`);
      const hold: TemperatureHold = holdType === "hours"
        ? { heatF, coolF, holdType, hours: input.hours! }
        : { heatF, coolF, holdType };
      await this.backend.setTemperature(before.id, hold);
      const after = await this.readAfterWrite(before.id);
      const holdDescription = holdType === "hours" ? `for ${input.hours} ${input.hours === 1 ? "hour" : "hours"}` : holdType === "indefinite" ? "until changed" : "until the next scheduled change";
      return { simulated: this.backend.kind === "demo", thermostat_id: before.id, requested: { heatF, coolF, hold_type: holdType, hold_description: holdDescription, ...(holdType === "hours" ? { hours: input.hours } : {}) }, delivery: "accepted", verification: Math.abs(after.heatF - heatF) < 0.11 && Math.abs(after.coolF - coolF) < 0.11 ? "observed" : "pending", verification_scope: "setpoints_only", hold_verification: "not_verified", thermostat: after };
    });
  }

  setMode(id: string, mode: HvacMode) {
    return this.serial(async () => {
      const before = await this.thermostat(id);
      this.writable(before);
      if (!["off", "heat", "cool", "auto"].includes(mode)) throw new UserError("Unsupported HVAC mode.");
      await this.backend.setMode(id, mode);
      const after = await this.readAfterWrite(id);
      return { simulated: this.backend.kind === "demo", thermostat_id: id, requested: { mode }, delivery: "accepted", verification: after.mode === mode ? "observed" : "pending", thermostat: after };
    });
  }

  resume(id: string) {
    return this.serial(async () => {
      const before = await this.thermostat(id);
      this.writable(before);
      await this.backend.resumeSchedule(id);
      return { simulated: this.backend.kind === "demo", thermostat_id: id, delivery: "accepted", verification: "not_verified", message: "Resume request accepted. Check the ecobee portal for the active schedule.", thermostat: await this.readAfterWrite(id) };
    });
  }
}
