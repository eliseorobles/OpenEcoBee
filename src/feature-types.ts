/** Fixed, validated thermostat operations. No URLs, scripts, or token inputs. */
export interface FeatureRequest {
  name: string;
  input: Record<string, unknown>;
}

export interface FeatureBackend {
  executeFeature(request: FeatureRequest): Promise<unknown>;
}
