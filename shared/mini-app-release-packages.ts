export const LEGACY_MINI_APP_IDS = {
  mojo: "01d8d54b-5b1c-4e8d-be21-e60aa6e42fc7",
  x_ai_digest: "5a22c351-114d-4b01-bf2d-216f187ae79b",
  github_activity: "0643df6c-24ea-4076-87b6-572d3637a4d9",
} as const;

const packages = {
  "agent-team": { releaseSlug: "agent-team", capability: "agent-team-v1" },
  usage: { releaseSlug: "work-tracker", capability: "usage-v1" },
  hongguo: { releaseSlug: "hongguo", capability: "hongguo-v1" },
  mojo: { releaseSlug: "mojo", capability: "mojo-poetry-v1" },
  x_ai_digest: { releaseSlug: "x-ai-digest", capability: "daily-x-site-v1" },
  github_activity: { releaseSlug: "github-activity", capability: "github-activity-site-v1" },
  bookkeeping: { releaseSlug: "bookkeeping", capability: null },
} as const;

export type MiniAppReleaseKind = keyof typeof packages;

export function miniAppReleasePackage(kind: MiniAppReleaseKind) {
  const { releaseSlug, capability } = packages[kind];
  return { packageId: `mashellhan.${releaseSlug}`, releaseSlug, capability };
}

export function matchesMiniAppReleasePackage(kind: MiniAppReleaseKind, release: {
  packageId: string;
  requires: readonly string[];
} | null | undefined): boolean {
  const { packageId, capability } = miniAppReleasePackage(kind);
  return release?.packageId === packageId && (capability === null
    ? release.requires.length === 0 : release.requires.length === 1 && release.requires[0] === capability);
}
