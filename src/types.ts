import type { FeatureRequest } from "./feature-types.js";

export type HvacMode = "off" | "heat" | "cool" | "auto";
export type Unit = "F" | "C";

export interface Thermostat {
  id: string;
  name: string;
  temperatureF: number;
  humidity: number;
  mode: string;
  heatF: number;
  coolF: number;
  connected: boolean;
  heatMinF: number;
  heatMaxF: number;
  coolMinF: number;
  coolMaxF: number;
  minDeltaF: number;
  equipment: string;
}

export type TemperatureHold = {
  heatF: number;
  coolF: number;
} & (
  | { holdType?: "hours"; hours: number }
  | { holdType: "indefinite" | "next_transition"; hours?: never }
);

export interface ThermostatBackend {
  readonly kind: "browser" | "demo";
  listThermostats(): Promise<Thermostat[]>;
  setTemperature(id: string, hold: TemperatureHold): Promise<void>;
  setMode(id: string, mode: HvacMode): Promise<void>;
  resumeSchedule(id: string): Promise<void>;
  executeFeature?(request: FeatureRequest): Promise<unknown>;
  close(): Promise<void>;
}

export class UserError extends Error {
  constructor(message: string) { super(message); this.name = "UserError"; }
}
