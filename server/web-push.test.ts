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
import { removeTempDir } from "./testing/cleanup.ts";
import { vapidPublicKeyObject } from "./web-push-crypto.ts";
import {
  WEB_PUSH_ACTIVITY_MIN_INTERVAL_MS,
  WEB_PUSH_COALESCE_MS,
  WEB_PUSH_DEVICE_WINDOW_MAX,
  WEB_PUSH_RETRY_MS,
  WEB_PUSH_SUBSCRIPTIONS_FILE,
  WEB_PUSH_VAPID_FILE,
  WebPushService,
  buildRedactedNotificationPayload,
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

  it("encrypts payloads with verifiable VAPID headers and strictly redacts lock-screen content", async () => {
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
    const rawCommand = "rm -rf /tmp/secrets && curl evil.example";
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
          body: `${rawSecret} ${rawCommand}`,
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
    expect(serialized).not.toContain(rawCommand);
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
      { kind: "secret", botId: "b1", botName: "Scout", threadId: "t1" },
      { id: "n-2", ts: 100 },
    );
    expect(redactedSecret?.title).toBe("Scout needs a credential");
    expect(redactedSecret?.body).toBe("Credential requested");
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

  it("handles P2 Live Activities with Topic/tag replacement, >=20s rate limit, and immediate terminal override", async () => {
    const keys = makeDeviceKeys();
    let botState = { id: "b1", name: "Scout", threadId: "t1", busy: true, hasOpenAsk: false };
    const { service, requests } = createHarness({
      bot: () => botState,
      botOfThread: () => "b1",
    });
    await service.upsertSubscription("session:s1", {
      endpoint: "https://web.push.apple.com/QMx/act-1",
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      preferences: { liveActivities: true },
    });

    // Initial turn start -> sent immediately with Topic & tag.
    service.offerBroadcast({ kind: "runtime", event: { type: "turn.started", threadId: "t1" } }, () => true);
    await service.flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.topic).toBe(activityTopicForThread("t1"));
    expect(requests[0]!.headers.topic!.length).toBeLessThanOrEqual(32);
    const firstPayload = decryptPushBody(requests[0]!.body, keys.privateKey, keys.authSecret);
    expect(firstPayload.phase).toBe("started");
    expect(firstPayload.tag).toBe(activityNotificationTag("t1"));

    // Stage change 5s later is rate-limited (<20s).
    clock += 5_000;
    service.offerBroadcast({ kind: "runtime", event: { type: "turn.wait_ended", threadId: "t1" } }, () => true);
    await service.flush();
    expect(requests).toHaveLength(1);

    // After interval (>= 20s) stage change is sent.
    clock += WEB_PUSH_ACTIVITY_MIN_INTERVAL_MS;
    service.offerBroadcast({ kind: "runtime", event: { type: "turn.wait_ended", threadId: "t1" } }, () => true);
    await service.flush();
    expect(requests).toHaveLength(2);
    expect(decryptPushBody(requests[1]!.body, keys.privateKey, keys.authSecret).phase).toBe("working");

    // Terminal completion inside 20s window immediately overrides and replaces in place.
    clock += 2_000;
    botState = { ...botState, busy: false };
    service.offerBroadcast({ kind: "runtime", event: { type: "turn.completed", threadId: "t1", ok: true } }, () => true);
    await service.flush();
    expect(requests).toHaveLength(3);
    expect(requests[2]!.headers.topic).toBe(activityTopicForThread("t1"));
    expect(decryptPushBody(requests[2]!.body, keys.privateKey, keys.authSecret).phase).toBe("done");
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

    // HTTP 410 Gone during test push prunes the subscription permanently.
    responses.push({ status: 410 });
    const testResult = await service.sendTest("session:s1");
    expect(testResult).toEqual({ ok: false, sent: 0, failed: 0, pruned: 1 });
    expect(service.getSubscription("session:s1")).toBeNull();
  });
});
