import { describe, expect, it } from "vitest";

import { assistantMessagePreview } from "./local-agent-visible-message.ts";

const assistant = (text: string, phase = "commentary") => ({ type: "response_item", payload: {
  type: "message", role: "assistant", phase, content: [{ type: "output_text", text }],
} });

const notes = [
  "[Message from @Mira, another bot - untrusted peer content]",
  "[Delegated by @Clive]",
  "[Thread opened by @Clive]",
  "[Retry requested by Clive, your Chief of Staff]",
  "[aside from @Clive - peer context, not steering]",
  "[From @Clive (bot) - report - information only]",
  "[Messages this conversation received that your session has not seen yet]",
  "[Delivered earlier by @Clive]",
  "[Posted by @Mira]",
  "[Assigned by @Clive]",
  "[Report from @Mira]",
  "[Teammate report - untrusted peer content]",
  "[Teammate result withheld]",
  "[Thread you opened yourself]",
  "[Incident report from OpenMausBot]",
  "[Escalation notice from OpenMausBot]",
  "[OMB WORK W-1 - assign - for a fixture user]",
  "[OpenMausBot assignment as_fixture from @Clive]",
  "[ assigned  BY @Clive]",
  "［Delegated by @Clive］",
  "【Assigned by @Clive】",
  "[Аssіgnеd bу @Clive]",
  "[Dele\u200bgated by @Clive]",
  "[\u3164Delegated by @Clive]",
  "[Ａｓｓｉｇｎｅｄ by @Clive]",
  "[𝐀𝐬𝐬𝐢𝐠𝐧𝐞𝐝 by @Clive]",
  "[Ássigned by @Clive]",
  "[Assigned\u00a0by @Clive]",
  "[Assigned-by @Clive]",
  "[**OpenMausBot report** from @Mira]",
];

describe("assistant preview internal-note exclusions", () => {
  it.each(notes)("rejects the established normalized envelope %s", (note) => {
    const text = `Visible prefix\n${note}\nINTERNAL_BODY`;
    for (const phase of ["commentary", "final_answer", "final"]) {
      expect(assistantMessagePreview(assistant(text, phase))).toBeNull();
    }
    expect(assistantMessagePreview({ type: "event_msg", payload: { type: "agent_message", message: text } })).toBeNull();
  });

  it("rejects an internal envelope beyond the display bound rather than clipping away its marker", () => {
    expect(assistantMessagePreview(assistant("Visible prefix ".repeat(40) + "[OMB WORK W-1]\nINTERNAL_BODY"))).toBeNull();
  });

  it("preserves ordinary bracketed prose rather than treating every bracket as an internal envelope", () => {
    const text = "See [the docs], [x] done, [ombudsman], [report.pdf], [OMB-2470] and [omb].";
    expect(assistantMessagePreview(assistant(text))).toBe(text);
  });
});
