// @vitest-environment happy-dom
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/api", () => ({ api: sent.api }));

import { useThreadNeedsInputStop } from "./thread-needs-input";

let root: Root;
let container: HTMLDivElement;

function Probe({ threadId = "selected", activity = "idle", enabled = true, stoppedAt }: {
  threadId?: string; activity?: string; enabled?: boolean; stoppedAt?: number;
}) {
  const canStop = useThreadNeedsInputStop("bot", threadId, activity, enabled, stoppedAt);
  return createElement("span", { "data-stop": canStop ? "yes" : "no" });
}

const render = async (props: Parameters<typeof Probe>[0] = {}) => {
  await act(async () => root.render(createElement(Probe, props)));
};
const canStop = () => container.querySelector("[data-stop]")?.getAttribute("data-stop");

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  sent.api.mockReset();
});

it("reads only the selected bot's parked conversation and refreshes after Stop", async () => {
  sent.api.mockResolvedValueOnce({ needsInput: [{ botId: "bot", threadId: "other" }, { botId: "other", threadId: "selected" }] })
    .mockResolvedValueOnce({ needsInput: [{ botId: "bot", threadId: "selected" }] })
    .mockResolvedValueOnce({ needsInput: [] });
  await render();
  expect(canStop()).toBe("no");
  expect(sent.api).toHaveBeenCalledWith("/api/threads/selected/job?since=0", expect.objectContaining({ background: true, signal: expect.any(AbortSignal) }));

  await render({ activity: "waiting-on-you" });
  expect(canStop()).toBe("yes");

  await render({ activity: "waiting-on-you", stoppedAt: 123 });
  expect(canStop()).toBe("no");
  expect(sent.api).toHaveBeenCalledTimes(3);

  await render({ threadId: "other", enabled: false });
  expect(canStop()).toBe("no");
  expect(sent.api).toHaveBeenCalledTimes(3);
});
