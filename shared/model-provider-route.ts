/** Display provenance for one model route inside an exact instance catalog. Its routing identity is instance-scoped. */
export interface ModelProviderRoute {
  id: string;
  /** A bounded display name from provider or connection metadata; absent when the provider is unknown. */
  label?: string;
  provenance: "configured" | "native" | "local" | "unknown";
  /** Display grouping for the same configured loopback endpoint and provider id. */
  connectionGroup?: string;
}
