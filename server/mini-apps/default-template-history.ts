import type { MiniAppShippedTemplateKind } from "../../shared/mini-apps.ts";

export const SHIPPED_TEMPLATE_SHA256: Record<MiniAppShippedTemplateKind, readonly string[]> = {
  bookkeeping: [
    "4f7a3a893d159ffdc74abbf7cf661e6308ef7a9ca23afa99680e157ec8d7b268",
    "7b2d4e122ab40c2d27494c75f662fd5e41d8ac213c72ee47b16f67fd677102ae",
  ],
  x_ai_digest: ["d666b5e1ab66557ed79bd21959d6d8092882f3127c666d19ec89b2e9ee554298"],
  github_activity: ["07188ec592d284717038e69d4555ca0b0024dbea942c1c2e438730230165fb9a"],
};

export const GITHUB_PENDING_TEMPLATE_SHA256 = "9ece01a026400263943ee64985792f13592727a3fbda0e005e0b5cae6d6584f8";
