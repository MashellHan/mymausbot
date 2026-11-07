import type { MiniAppShippedTemplateKind } from "../../shared/mini-apps.ts";

export const SHIPPED_TEMPLATE_SHA256: Record<MiniAppShippedTemplateKind, readonly string[]> = {
  bookkeeping: [
    "4f7a3a893d159ffdc74abbf7cf661e6308ef7a9ca23afa99680e157ec8d7b268",
    "7b2d4e122ab40c2d27494c75f662fd5e41d8ac213c72ee47b16f67fd677102ae",
  ],
  x_ai_digest: [
    "d666b5e1ab66557ed79bd21959d6d8092882f3127c666d19ec89b2e9ee554298",
    "0016824b1ab278d65381158f0e851e00dfaa5c7036f54ebda6087fd7e6f9a389",
    "01072481dd6d85afb991ca835c153f401f1a59a5844eb502dd4bd9ee69194523",
  ],
  github_activity: [
    "07188ec592d284717038e69d4555ca0b0024dbea942c1c2e438730230165fb9a",
    "7394390a494a10be5c959ac2b8fd7817214548aa157dfafe6755a7cc405e9fbd",
    "8d80cef615e76ccb5a8a65861c5f966a69ff430a1ad5718924aa03d1712f8cc7",
  ],
};

export const GITHUB_PENDING_TEMPLATE_SHA256 = "9ece01a026400263943ee64985792f13592727a3fbda0e005e0b5cae6d6584f8";
