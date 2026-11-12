/** Display provenance for one model route inside an exact instance catalog. The pair of instanceId and id is the
 * grouping identity; labels never join routes, and this metadata grants no authority to select or use a model. */
export interface ModelProviderRoute {
  id: string;
  /** A bounded display name from provider or connection metadata; absent when the provider is unknown. */
  label?: string;
  provenance: "configured" | "native" | "local" | "unknown";
}
