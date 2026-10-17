import { UserError, type HvacMode, type TemperatureHold, type Thermostat, type ThermostatBackend } from "./types.js";

export class DemoBackend implements ThermostatBackend {
  readonly kind = "demo" as const;

  private readonly thermostat: Thermostat = {
    id: "demo-downstairs",
    name: "Downstairs (Demo)",
    temperatureF: 72,
    humidity: 45,
    mode: "auto",
    heatF: 68,
    coolF: 75,
    connected: true,
    heatMinF: 45,
    heatMaxF: 79,
    coolMinF: 65,
    coolMaxF: 92,
    minDeltaF: 5,
    equipment: "idle",
  };

  async listThermostats(): Promise<Thermostat[]> {
    return [structuredClone(this.thermostat)];
  }

  async setTemperature(id: string, hold: TemperatureHold): Promise<void> {
    this.requireThermostat(id);
    this.thermostat.heatF = hold.heatF;
    this.thermostat.coolF = hold.coolF;
  }

  async setMode(id: string, mode: HvacMode): Promise<void> {
    this.requireThermostat(id);
    this.thermostat.mode = mode;
  }

  async resumeSchedule(id: string): Promise<void> {
    this.requireThermostat(id);
    this.thermostat.heatF = 68;
    this.thermostat.coolF = 75;
  }

  async close(): Promise<void> {}

  private requireThermostat(id: string): void {
    if (id !== this.thermostat.id) {
      throw new UserError(`Thermostat "${id}" was not found.`);
    }
  }
}
