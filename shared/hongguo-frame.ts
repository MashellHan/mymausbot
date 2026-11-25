import type { HongguoPlaybackResponse } from "./hongguo-mini-app.ts";

export const HONGGUO_FRAME_CAPABILITY = "hongguo-v1";
export const HONGGUO_PACKAGE_ID = "mashellhan.hongguo";

export interface HongguoFrameContext { appId: string; revision: number; visible: boolean; refreshKey: number }
export interface HongguoPlayerBounds { x: number; y: number; width: number; height: number }
export interface HongguoPlayerPosition { positionSeconds: number; durationSeconds: number | null; paused: boolean }
export type HongguoPlayerRestore = { kind: "history"; positionSeconds: number }
  | { kind: "quality"; fromPlaybackId: string; positionSeconds: number; paused: boolean };
export type HongguoPlayerEvent = { playbackId: string } & (
  | ({ type: "ready" | "complete" | "time" | "playing" | "paused" | "seeked" | "ended" } & HongguoPlayerPosition)
  | { type: "error"; status?: number }
);

export type HongguoFramePlayback = Extract<HongguoPlaybackResponse, { status: "unavailable" }>
  | (Omit<Extract<HongguoPlaybackResponse, { status: "ready" }>, "mediaUrl"> & { playbackId: string });

export type HongguoFrameRequest = { mausMiniApp: 1; type: "hongguo-request"; id: string; operation: string; input: unknown };
export type HongguoFrameCancel = { mausMiniApp: 1; type: "hongguo-cancel"; id: string };
export type HongguoFrameReply = { mausMiniApp: 1; type: "hongguo-result"; id: string } & (
  | { result: unknown }
  | { error: { status: number } | { aborted: true } }
);
export type HongguoFrameNotice = { mausMiniApp: 1 } & (
  | { type: "hongguo-context"; context: HongguoFrameContext }
  | { type: "hongguo-player-event"; event: HongguoPlayerEvent }
  | { type: "hongguo-fullscreen"; active: boolean }
);
