import { createDecipheriv, createECDH, createHmac, hkdfSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  WEB_PUSH_VAPID_KEY_ROUTE,
  activityNotificationTag,
  activityTopicForThread,
  type WebPushPayload,
} from "../shared/web-push.ts";
import { defaultPwaBridgeConfig, savePwaBridgeConfig } from "./pwa-bridge-config.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { vapidPublicKeyObject } from "./web-push-crypto.ts";
import {
  DEFAULT_VAPID_SUBJECT,
  WEB_PUSH_COALESCE_MS,
  WEB_PUSH_DEVICE_WINDOW_MAX,
  WEB_PUSH_DEVICE_WINDOW_MS,
  WEB_PUSH_NOTIFY_DEDUPE_MS,
  WEB_PUSH_RETRY_MS,
  WEB_PUSH_SUBSCRIPTIONS_FILE,
  WEB_PUSH_VAPID_FILE,
  WebPushService,
  buildNotificationPayload,
  buildRedactedNotificationPayload,
  defaultVapidSubject,
  isForbiddenWebPushIp,
  resolveAndValidateWebPushEndpoint,
  validateWebPushEndpoint,
  type WebPushOptions,
  type WebPushTransportRequest,
  type WebPushTransportResponse,
} from "./web-push.ts";

function decryptPushBody(ciphertext: Buffer, uaPrivateKey: Buffer, authSecret: Buffer): WebPushPayload {
  const salt = ciphertext.subarray(0, 16);
  const idlen = ciphertext.readUInt8(20);
  const asPublic = ciphertext.subarray(21, 21 + idlen);
  const encrypted = ciphertext.subarray(21 + idlen);
  const body = encrypted.subarray(0, encrypted.length - 16);
  const tag = encrypted.subarray(encrypted.length - 16);

  const uaEcdh = createECDH("prime256v1");
  uaEcdh.setPrivateKey(uaPrivateKey);
  const uaPublic = uaEcdh.getPublicKey(undefined, "uncompressed");
  const ecdhSecret = uaEcdh.computeSecret(asPublic);

  const prkKey = createHmac("sha256", authSecret).update(ecdhSecret).digest();
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "ascii"), uaPublic, asPublic]);
  const ikm = createHmac("sha256", prkKey).update(Buffer.concat([keyInfo, Buffer.from([0x01])])).digest();

  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "ascii"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "ascii"), 12));

  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(tag);
  const padded = Buffer.concat([decipher.update(body), decipher.final()]);
  const delim = padded.lastIndexOf(0x02);
  return JSON.parse(padded.subarray(0, delim).toString("utf8")) as WebPushPayload;
}

function makeDeviceKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const authSecret = Buffer.alloc(16, 0x33);
  return {
    privateKey: ecdh.getPrivateKey(),
    authSecret,
    p256dh: ecdh.getPublicKey(undefined, "uncompressed").toString("base64url"),
    auth: authSecret.toString("base64url"),
  };
}

const dirs: string[] = [];
let dataDir: string;
let clock: number;
let timers: Array<{ run: () => void; at: number }>;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "omb-web-push-"));
  dirs.push(dataDir);
  clock = 10_000_000;
  timers = [];
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(removeTempDir));
});

function createHarness(
  overrides: Partial<WebPushOptions> & {
    liveKeys?: Set<string>;
    responses?: Array<WebPushTransportResponse | "network-error">;
  } = {},
) {
  const requests: WebPushTransportRequest[] = [];
  const logs: string[] = [];
  const liveKeys = overrides.liveKeys ?? new Set<string>();
  const responses = [...(overrides.responses ?? [])];
  const service = new WebPushService({
    dataDir,
    now: () => clock,
    log: (line) => logs.push(line),
    liveSseKeys: () => liveKeys,
    lookup: async () => [{ address: "17.57.145.10", family: 4 }],
    transport: async (req) => {
      requests.push(req);
      const next = responses.shift();
      if (next === "network-error") throw new Error("ECONNRESET");
      return next ?? { status: 201 };
    },
    timers: {
      set: (run, ms) => {
        const handle = { run, at: clock + ms };
        timers.push(handle);
        return handle;
      },
      clear: (handle) => {
        timers = timers.filter((item) => item !== handle);
      },
    },
    ...overrides,
  });
  return { service, requests, logs, liveKeys, responses };
}

async function advance(service: WebPushService, ms: number): Promise<void> {
  clock += ms;
  for (const timer of timers.filter((entry) => entry.at <= clock)) {
    timers = timers.filter((entry) => entry !== timer);
    timer.run();
  }
  await service.flush();
}

describe("WebPushService", () => {
  it("persists VAPID keys with 0600 mode, reloads them across restarts, and never logs secrets", async () => {
    const keys = makeDeviceKeys();
    const first = createHarness();
    const pub1 = first.service.vapidPublicKey();
    expect(pub1).toBeTruthy();

    const vapidPath = join(dataDir, WEB_PUSH_VAPID_FILE);
    if (process.platform !== "win32") {
      expect(statSync(vapidPath).mode & 0o777).toBe(0o600);
    }
    const storedVapid = JSON.parse(readFileSync(vapidPath, "utf8")) as { privateKey: string; publicKey: string };
    expect(first.logs.join("\n")).not.toContain(storedVapid.privateKey);

    await first.service.upsertSubscription("session:phone-1", {
      endpoint: "https://web.push.apple.com/QMx/token-1",
      keys: { p256dh: keys.p256dh, auth: keys.auth },
    });
    if (process.platform !== "win32") {
      expect(statSync(join(dataDir, WEB_PUSH_SUBSCRIPTIONS_FILE)).mode & 0o777).toBe(0o600);
    }

    const second = createHarness();
    expect(second.service.vapidPublicKey()).toBe(pub1);
    expect(second.service.getSubscription("session:phone-1")?.endpoint).toBe("https://web.push.apple.com/QMx/token-1");
    expect(WEB_PUSH_VAPID_KEY_ROUTE).toBe("/api/push/web/vapid-key");
  });

  it("blocks non-https, embedded credentials, loopback, private, link-local, metadata, and DNS rebinding endpoints", async () => {
    for (const badUrl of [
      "http://web.push.apple.com/token",
      "https://user:pass@web.push.apple.com/token",
      "https://localhost/push",
      "https://sub.localhost/push",
      "https://printer.local/push",
      "https://127.0.0.1/push",
      "https://[::1]/push",
      "https://10.0.0.5/push",
      "https://172.16.4.10/push",
      "https://192.168.1.20/push",
      "https://169.254.169.254/latest/meta-data",
      "https://[fe80::1]/push",
      "https://[fc00::1]/push",
      "https://[::ffff:127.0.0.1]/push",
      "https://web.push.apple.com/token#frag",
    ]) {
      expect(() => validateWebPushEndpoint(badUrl), badUrl).toThrow();
    }

    expect(isForbiddenWebPushIp("100.64.0.1")).toBe(true);
    expect(isForbiddenWebPushIp("64:ff9b::127.0.0.1")).toBe(true);
    expect(isForbiddenWebPushIp("17.57.145.10")).toBe(false);

    // DNS rebinding guard: initial upsert resolves public IP, delivery lookup flips to 127.0.0.1 and is blocked.
    let resolveToPrivate = false;
    const keys = makeDeviceKeys();
    const { service, requests } = createHarness({
      lookup: async () =>
        resolveToPrivate
          ? [{ address: "127.0.0.1", family: 4 }]
          : [{ address: "17.57.145.10", family: 4 }],
    });

    await service.upsertSubscription("session:s1", {
      endpoint: "https://push.rebind.example/sub/1",
      keys: { p256dh: keys.p256dh, auth: keys.auth },
    });
    resolveToPrivate = true;

    await expect(
      resolveAndValidateWebPushEndpoint("https://push.rebind.example/sub/1", async () => [{ address: "169.254.169.254", family: 4 }]),
    ).rejects.toThrow(/forbidden/);

    service.offerBroadcast(
      {
        kind: "notify",
        notification: { kind: "approval", botId: "b1", botName: "Scout", threadId: "t1", title: "x", body: "SECRET" },
      },
      () => true,
    );
    await service.flush();
    expect(requests).toHaveLength(0);
  });

  it("encrypts payloads with verifiable VAPID headers, scrubs secrets from previews, and strictly redacts secret prompts", async () => {
    const keys = makeDeviceKeys();
    const { service, requests } = createHarness({
      unreadCount: () => 4,
      room: () => ({ id: "g1", name: "Ops Room" }),
    });
    await service.upsertSubscription("session:s1", {
      endpoint: "https://web.push.apple.com/QMx/sub-1",
      keys: { p256dh: keys.p256dh, auth: keys.auth },
    });

    const rawSecret = "sk-live-super-secret-value";
    const ghToken = "ghp_1234567890abcdefghijklmnop123456";
    const summaryText = "Allow running deployment check";
    service.offerBroadcast(
      {
        kind: "notify",
        notification: {
          id: "n-1",
          kind: "approval",
          botId: "bot-1",
          botName: "Scout",
          threadId: "thread-1",
          groupId: "g1",
          title: `Approval with ${rawSecret}`,
          body: `**${summaryText}** using ${rawSecret} and ${ghToken}`,
        },
      },
      () => true,
    );
    await service.flush();

    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.pinnedAddress).toEqual({ address: "17.57.145.10", family: 4 });
    expect(req.headers["content-encoding"]).toBe("aes128gcm");
    expect(req.headers.urgency).toBe("high");

    const authMatch = /^vapid t=([^,]+), k=(.+)$/.exec(req.headers.authorization!);
    expect(authMatch).not.toBeNull();
    const [, jwt, pubKey] = authMatch!;
    expect(pubKey).toBe(service.vapidPublicKey());
    const [h, c, s] = jwt!.split(".") as [string, string, string];
    expect(
      verify("sha256", Buffer.from(`${h}.${c}`, "ascii"), { key: vapidPublicKeyObject(pubKey!), dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")),
    ).toBe(true);

    const decrypted = decryptPushBody(req.body, keys.privateKey, keys.authSecret);
    const serialized = JSON.stringify(decrypted);
    expect(serialized).not.toContain(rawSecret);
    expect(serialized).not.toContain(ghToken);
    expect(decrypted.body).toContain(summaryText);
    expect(decrypted.body).not.toContain("**");
    expect(decrypted).toMatchObject({
      version: 1,
      id: "n-1",
      kind: "approval",
      botId: "bot-1",
      botName: "Scout",
      threadId: "thread-1",
      groupId: "g1",
      unreadCount: 4,
      url: "/chat/thread-1",
    });

    const redactedSecret = buildRedactedNotificationPayload(
      {
        kind: "secret",
        botId: "b1",
        botName: "Scout",
        threadId: "t1",
        title: "Stripe Live Key",
        body: `Enter ${rawSecret}`,
      },
      { id: "n-2", ts: 100 },
    );
    expect(redactedSecret?.title).toBe("Scout needs a credential");
    expect(redactedSecret?.body).toBe("Credential requested");
    expect(JSON.stringify(redactedSecret)).not.toContain("Stripe");
    expect(JSON.stringify(redactedSecret)).not.toContain(rawSecret);

    const zhSecret = buildNotificationPayload(
      {
        kind: "secret",
        botId: "b2",
        botName: "二娃 - 千里眼",
        threadId: "t2",
        title: "OpenAI API Key",
        body: rawSecret,
      },
      { id: "n-3", ts: 101 },
    );
    expect(zhSecret?.title).toBe("二娃 - 千里眼 需要凭证");
    expect(zhSecret?.body).toBe("请打开应用安全填写");
    expect(JSON.stringify(zhSecret)).not.toContain("OpenAI");
    expect(JSON.stringify(zhSecret)).not.toContain(rawSecret);
  });

  it("delivers localized Chinese/English dynamic summaries for done, question, approval, and failures", async () => {
    const keys = makeDeviceKeys();
    const { service, requests } = createHarness({
      room: (n) => (n.groupId ? { id: n.groupId, name: "发布群" } : undefined),
    });
    await service.upsertSubscription("session:s1", {
      endpoint: "https://web.push.apple.com/QMx/sub-zh",
      keys: { p256dh: keys.p256dh, auth: keys.auth },
    });

    service.offerBroadcast(
      {
        kind: "notify",
        notification: {
          id: "zh-done-1",
          kind: "done",
          botId: "bot-erwa",
          botName: "二娃 - 千里眼",
          threadId: "t-zh-1",
          body: "**构建已完成**，所有 12 项校验全部通过。",
        },
      },
      () => true,
    );
    service.offerBroadcast(
      {
        kind: "notify",
        notification: {
          id: "zh-q-1",
          kind: "question",
          botId: "bot-erwa",
          botName: "二娃 - 千里眼",
          threadId: "t-zh-2",
          groupId: "g-rel",
          body: "是否立即推送到生产环境？",
        },
      },
      () => true,
    );
    service.offerBroadcast(
      {
        kind: "notify",
        notification: {
          id: "zh-fail-1",
          kind: "turn-failed",
          botId: "bot-erwa",
          botName: "二娃 - 千里眼",
          threadId: "t-zh-3",
          body: "连接上游超时（HTTP 504）",
        },
      },
      () => true,
    );
    await service.flush();

    expect(requests).toHaveLength(3);
    const donePayload = decryptPushBody(requests[0]!.body, keys.privateKey, keys.authSecret);
    expect(donePayload.title).toBe("二娃 - 千里眼");
    expect(donePayload.body).toBe("构建已完成，所有 12 项校验全部通过。");

    const questionPayload = decryptPushBody(requests[1]!.body, keys.privateKey, keys.authSecret);
    expect(questionPayload.title).toBe("二娃 - 千里眼 · 发布群 向你提问");
    expect(questionPayload.body).toBe("是否立即推送到生产环境？");

    const failPayload = decryptPushBody(requests[2]!.body, keys.privateKey, keys.authSecret);
    expect(failPayload.title).toBe("二娃 - 千里眼 运行出错");
    expect(failPayload.body).toBe("连接上游超时（HTTP 504）");
  });

  it("enforces tier preferences, spend admin gate, focused SSE dedupe, and audience rules", async () => {
    const keysA = makeDeviceKeys();
    const keysB = makeDeviceKeys();
    const liveKeys = new Set<string>(["session:focused"]);
    const { service, requests } = createHarness({
      liveKeys,
      isAdmin: (key) => key === "session:admin",
    });

    await service.upsertSubscription("session:focused", {
      endpoint: "https://web.push.apple.com/QMx/focused",
      keys: { p256dh: keysA.p256dh, auth: keysA.auth },
      preferences: { enabled: true, finished: true, spend: false },
    });
    await service.upsertSubscription("session:admin", {
      endpoint: "https://fcm.googleapis.com/fcm/send/admin",
      keys: { p256dh: keysB.p256dh, auth: keysB.auth },
      preferences: { enabled: true, finished: false, spend: true, mentions: true },
    });
    service.setFocusedThread("session:focused", "t-focused");

    // Focused SSE on t-focused suppresses non-urgent done notification.
    service.offerBroadcast(
      { kind: "notify", notification: { kind: "done", botId: "b1", botName: "Scout", threadId: "t-focused" } },
      () => true,
    );
    await service.flush();
    expect(requests).toHaveLength(0);

    // Spend only reaches admin devices and respects audience check.
    service.offerBroadcast(
      { kind: "notify", notification: { kind: "spend", botId: "b1", botName: "Scout", threadId: "t-other" } },
      (key) => key === "session:admin" || key === "session:focused",
    );
    await service.flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe("/fcm/send/admin");
  });

  it("suppresses noisy bot/runtime stage pushes (Started working / Waiting) and only pushes real notify events once", async () => {
    const keys = makeDeviceKeys();
    let botState = { id: "b1", name: "二娃 - 千里眼", threadId: "t1", busy: true, hasOpenAsk: false };
    const { service, requests } = createHarness({
      bot: () => botState,
      botOfThread: () => "b1",
    });
    await service.upsertSubscription("session:s1", {
      endpoint: "https://web.push.apple.com/QMx/dedupe-1",
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      preferences: { liveActivities: true, finished: true, urgent: true, failures: true },
    });

    // 1. Intermediate bot/runtime broadcasts (turn.started, item.started, turn.wait_started, request.opened, turn.completed) emit 0 pushes.
    service.offerBroadcast({ kind: "runtime", event: { type: "turn.started", threadId: "t1" } }, () => true);
    service.offerBroadcast({ kind: "bot", bot: { id: "b1" } }, () => true);
    service.offerBroadcast(
      { kind: "runtime", event: { type: "item.started", itemType: "tool", threadId: "t1", title: "web_search", summary: "OpenMausBot" } },
      () => true,
    );
    service.offerBroadcast({ kind: "runtime", event: { type: "turn.wait_started", threadId: "t1", resource: "browser" } }, () => true);
    botState = { ...botState, hasOpenAsk: true };
    service.offerBroadcast({ kind: "runtime", event: { type: "request.opened", threadId: "t1" } }, () => true);
    service.offerBroadcast({ kind: "bot", bot: { id: "b1" } }, () => true);
    botState = { ...botState, busy: false, hasOpenAsk: false };
    service.offerBroadcast({ kind: "runtime", event: { type: "turn.completed", threadId: "t1", ok: true } }, () => true);
    await service.flush();
    expect(requests).toHaveLength(0);

    // 2. Real approval notify sends 1 push with scrubbed summary.
    service.offerBroadcast(
      {
        kind: "notify",
        notification: {
          id: "ask-1",
          kind: "approval",
          botId: "b1",
          botName: "二娃 - 千里眼",
          threadId: "t1",
          body: "需要确认执行部署脚本",
        },
      },
      () => true,
    );
    await service.flush();
    expect(requests).toHaveLength(1);
    const approval = decryptPushBody(requests[0]!.body, keys.privateKey, keys.authSecret);
    expect(approval.kind).toBe("approval");
    expect(approval.body).toBe("需要确认执行部署脚本");

    // 3. Real done notify sends 1 push with clean title & reply summary.
    service.offerBroadcast(
      {
        kind: "notify",
        notification: {
          id: "done-1",
          kind: "done",
          botId: "b1",
          botName: "二娃 - 千里眼",
          threadId: "t1",
          body: "部署脚本已运行完成，无报错。",
        },
      },
      () => true,
    );
    await service.flush();
    expect(requests).toHaveLength(2);
    const done = decryptPushBody(requests[1]!.body, keys.privateKey, keys.authSecret);
    expect(done.kind).toBe("done");
    expect(done.title).toBe("二娃 - 千里眼");
    expect(done.body).toBe("部署脚本已运行完成，无报错。");

    // 4. Duplicate notify by same id (even >15s later) OR identical (threadId, kind, body) within 15s is deduplicated.
    service.offerBroadcast(
      {
        kind: "notify",
        notification: {
          id: "done-1-dup-body",
          kind: "done",
          botId: "b1",
          botName: "二娃 - 千里眼",
          threadId: "t1",
          body: "部署脚本已运行完成，无报错。",
        },
      },
      () => true,
    );
    clock += WEB_PUSH_NOTIFY_DEDUPE_MS + 1_000;
    service.offerBroadcast(
      {
        kind: "notify",
        notification: {
          id: "done-1",
          kind: "done",
          botId: "b1",
          botName: "二娃 - 千里眼",
          threadId: "t1",
          body: "新内容但相同 id",
        },
      },
      () => true,
    );
    await service.flush();
    expect(requests).toHaveLength(2);

    // 5. Real turn-failed and P2 brief notifies still deliver cleanly once each.
    service.offerBroadcast({ kind: "runtime", event: { type: "turn.completed", threadId: "t1", ok: false } }, () => true);
    service.offerBroadcast(
      {
        kind: "notify",
        notification: {
          id: "fail-1",
          kind: "turn-failed",
          botId: "b1",
          botName: "二娃 - 千里眼",
          threadId: "t1",
          body: "模型请求超时",
        },
      },
      () => true,
    );
    service.offerBroadcast(
      {
        kind: "notify",
        notification: {
          id: "brief-1",
          kind: "brief",
          botId: "b1",
          botName: "二娃 - 千里眼",
          threadId: "t1",
          body: "每日简报已更新",
        },
      },
      () => true,
    );
    await service.flush();
    expect(requests).toHaveLength(4);
    const failed = decryptPushBody(requests[2]!.body, keys.privateKey, keys.authSecret);
    expect(failed.kind).toBe("turn-failed");
    expect(failed.body).toBe("模型请求超时");
    expect(requests[3]!.headers.topic).toBe(activityTopicForThread("t1"));
    const brief = decryptPushBody(requests[3]!.body, keys.privateKey, keys.authSecret);
    expect(brief.tag).toBe(activityNotificationTag("t1"));
    expect(brief.body).toBe("每日简报已更新");
  });

  it("coalesces 10s same-slot pushes, caps 30/10min per device, retries transiently, and prunes on 404/410", async () => {
    const keys = makeDeviceKeys();
    const queuedResponses: Array<WebPushTransportResponse | "network-error"> = [
      { status: 201 }, // first wait notification
      "network-error", // brief triggers retry
      { status: 201 }, // retry succeeds
    ];
    const { service, requests, responses } = createHarness({ responses: queuedResponses });
    await service.upsertSubscription("session:s1", {
      endpoint: "https://web.push.apple.com/QMx/sub-cap",
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      preferences: { liveActivities: true },
    });

    // Two waits on same (device, thread, kind) within 10s -> only 1 sent.
    service.offerBroadcast({ kind: "notify", notification: { kind: "wait", botId: "b1", botName: "Scout", threadId: "t1" } }, () => true);
    await service.flush();
    clock += 2_000;
    service.offerBroadcast({ kind: "notify", notification: { kind: "wait", botId: "b1", botName: "Scout", threadId: "t1" } }, () => true);
    await service.flush();
    expect(requests).toHaveLength(1);

    // Retry on network error then succeed after 5s backoff.
    clock += WEB_PUSH_COALESCE_MS;
    service.offerBroadcast({ kind: "notify", notification: { kind: "brief", botId: "b1", botName: "Scout", threadId: "t2" } }, () => true);
    await service.flush();
    expect(requests).toHaveLength(2);
    expect(service.pending()).toBe(1);
    await advance(service, WEB_PUSH_RETRY_MS[0]);
    expect(requests).toHaveLength(3);
    expect(service.pending()).toBe(0);

    // Fill up remaining capacity toward 30/10min cap using urgent notifications across distinct threads.
    for (let i = 0; i < WEB_PUSH_DEVICE_WINDOW_MAX + 5; i++) {
      service.offerBroadcast(
        { kind: "notify", notification: { kind: "approval", botId: "b1", botName: "Scout", threadId: `cap-${i}` } },
        () => true,
      );
    }
    await service.flush();
    // Total sent over 10min window: 1 initial + 2 attempted (1 network error + 1 retry) + 28 capped = 31 transport calls (30 successful deliveries).
    expect(requests.length).toBe(3 + (WEB_PUSH_DEVICE_WINDOW_MAX - 2));

    // HTTP 410 Gone during test push prunes the subscription permanently, except sendTest also respects the 30/10min device quota,
    // so advance the clock by 10 minutes first to verify 410 pruning and add explicit sendTest throttle + 429 pause checks.
    clock += WEB_PUSH_DEVICE_WINDOW_MS;
    responses.push({ status: 410 });
    const testResult = await service.sendTest("session:s1");
    expect(testResult).toEqual({ ok: false, sent: 0, failed: 0, pruned: 1 });
    expect(service.getSubscription("session:s1")).toBeNull();
  });

  it("enforces per-device cooldown, 30/10min quota, and origin 429 pause in sendTest()", async () => {
    const keys = makeDeviceKeys();
    const { service, requests } = createHarness({
      responses: [{ status: 201 }, { status: 429, retryAfterMs: 120_000 }],
    });
    await service.upsertSubscription("session:s-test", {
      endpoint: "https://web.push.apple.com/QMx/sub-test",
      keys: { p256dh: keys.p256dh, auth: keys.auth },
    });

    const first = await service.sendTest("session:s-test");
    expect(first).toEqual({ ok: true, sent: 1, failed: 0, pruned: 0 });
    await expect(service.sendTest("session:s-test")).rejects.toMatchObject({ status: 429 });
    expect(requests).toHaveLength(1);

    clock += 16_000;
    const second = await service.sendTest("session:s-test");
    expect(second).toEqual({ ok: false, sent: 0, failed: 1, pruned: 0 });

    clock += 16_000;
    await expect(service.sendTest("session:s-test")).rejects.toMatchObject({ status: 429 });
    expect(requests).toHaveLength(2);
  });

  it("uses a non-.invalid default VAPID subject, prefers configured pwaOrigin or env override, and logs redacted 403 diagnostics", async () => {
    expect(DEFAULT_VAPID_SUBJECT).toBe("https://openmausbot.com");
    expect(DEFAULT_VAPID_SUBJECT.endsWith(".invalid")).toBe(false);
    expect(defaultVapidSubject(dataDir, {})).toBe(DEFAULT_VAPID_SUBJECT);
    expect(defaultVapidSubject(dataDir, { OMB_WEB_PUSH_SUBJECT: "mailto:ops@example.com" })).toBe("mailto:ops@example.com");
    expect(defaultVapidSubject(dataDir, { OMB_WEB_PUSH_SUBJECT: "mailto:bad@openmausbot.invalid" })).toBe(DEFAULT_VAPID_SUBJECT);
    expect(defaultVapidSubject(dataDir, { OMB_WEB_PUSH_SUBJECT: "https://localhost:3000" })).toBe(DEFAULT_VAPID_SUBJECT);

    savePwaBridgeConfig(dataDir, { ...defaultPwaBridgeConfig(), pwaOrigin: "http://127.0.0.1:4173" });
    expect(defaultVapidSubject(dataDir, {})).toBe(DEFAULT_VAPID_SUBJECT);

    savePwaBridgeConfig(dataDir, { ...defaultPwaBridgeConfig(), pwaOrigin: "https://app.openmausbot.invalid" });
    expect(defaultVapidSubject(dataDir, {})).toBe(DEFAULT_VAPID_SUBJECT);

    savePwaBridgeConfig(dataDir, { ...defaultPwaBridgeConfig(), pwaOrigin: "https://mausbot.mxhan.com" });
    expect(defaultVapidSubject(dataDir, {})).toBe("https://mausbot.mxhan.com");
    expect(defaultVapidSubject(dataDir, { OMB_WEB_PUSH_SUBJECT: "https://custom.example.com" })).toBe("https://custom.example.com");

    const keys = makeDeviceKeys();
    const secretPath = "/QMx/secret-apple-device-token-999";
    const { service, requests, logs } = createHarness({ responses: [{ status: 403 }] });
    await service.upsertSubscription("session:s-403", {
      endpoint: `https://web.push.apple.com${secretPath}`,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
    });

    const result = await service.sendTest("session:s-403");
    expect(result).toEqual({ ok: false, sent: 0, failed: 1, pruned: 0 });
    expect(requests).toHaveLength(1);
    const jwt = /^vapid t=([^,]+), k=/.exec(requests[0]!.headers.authorization!)?.[1] ?? "";
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")) as { sub: string };
    expect(claims.sub).toBe("https://mausbot.mxhan.com");
    expect(logs).toContain("[web-push] delivery rejected by https://web.push.apple.com (HTTP 403)");
    expect(logs.join("\n")).not.toContain(secretPath);
  });
});
