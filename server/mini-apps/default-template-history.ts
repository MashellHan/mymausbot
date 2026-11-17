import type { MiniAppShippedTemplateKind } from "../../shared/mini-apps.ts";

export const SHIPPED_TEMPLATE_SHA256: Record<MiniAppShippedTemplateKind, readonly string[]> = {
  bookkeeping: [
    "2cdf85124737205c693df442bff7e8da5190aa8df8c7e42dde4b901be96789e9",
    "4f7a3a893d159ffdc74abbf7cf661e6308ef7a9ca23afa99680e157ec8d7b268",
    "7b2d4e122ab40c2d27494c75f662fd5e41d8ac213c72ee47b16f67fd677102ae",
    "31138080fea253d60cbd5286788fae32258530ebd238f3510a43c2358603aed1",
  ],
  x_ai_digest: [
    "d666b5e1ab66557ed79bd21959d6d8092882f3127c666d19ec89b2e9ee554298",
    "0016824b1ab278d65381158f0e851e00dfaa5c7036f54ebda6087fd7e6f9a389",
    "01072481dd6d85afb991ca835c153f401f1a59a5844eb502dd4bd9ee69194523",
    "22774e3475d85e7e095b29441f18a532465636d9c527c418a089a7f9ea3e9128",
    "c13dd3fa12979df58d3b6679f6a6496628c643a30a02b7119d376804324e5651",
  ],
  github_activity: [
    "07188ec592d284717038e69d4555ca0b0024dbea942c1c2e438730230165fb9a",
    "7394390a494a10be5c959ac2b8fd7817214548aa157dfafe6755a7cc405e9fbd",
    "8d80cef615e76ccb5a8a65861c5f966a69ff430a1ad5718924aa03d1712f8cc7",
    "e68d96783a14fbeadca960a2f9cb2b929a538b214192835c7b6e24fc47c0282b",
    "963f24b2e95a62e725e605365ca081cb4b19a8dad6a126d137d2871cdc53d0f7",
  ],
};

export const GITHUB_PENDING_TEMPLATE_SHA256 = "9ece01a026400263943ee64985792f13592727a3fbda0e005e0b5cae6d6584f8";

/** MashellHan/mymausbotminiapps 0ac9ee68a8ecbf613944d09cac8a092a4566aa08, apps/agent-team/index.html. */
export const REVIEWED_AGENT_TEAM_HTML_SHA256 = "2c4e806fef13de0bc8a9861bd642876dc89255336b041928d417bdadc22959b0";

/** Native Agent Team placeholders shipped at d45d7e4 and 6ef6637. */
export const AGENT_TEAM_NATIVE_PLACEHOLDER_SHA256 = [
  "c3740f8ef57d3b00e6956bd9a168a45a4622afeb4e94edf817958939706c56ee",
  "6c83e3550c95c47babb8f977a5d17e82445e5ffcfaf904b58cb971334b47a772",
] as const;
