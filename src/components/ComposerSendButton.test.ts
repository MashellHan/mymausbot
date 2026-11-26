import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ComposerSendButton } from "./ComposerSendButton";

describe("ComposerSendButton", () => {
  it("keeps the active upward send arrow and tone even when waits is passed", () => {
    const markup = renderToStaticMarkup(createElement(ComposerSendButton, {
      compact: true,
      waits: true,
      label: "Send follow-up",
      title: "Send without waiting for the current turn",
      look: { className: "bg-accent text-accent-ink", style: { backgroundColor: "#2563eb" } },
      disabled: false,
      onSend: vi.fn(),
      onChoose: vi.fn(),
    }));

    expect(markup).toContain("lucide-arrow-up");
    expect(markup).not.toContain("lucide-clock");
    expect(markup).toContain("background-color:#2563eb");
    expect(markup).toContain("aria-label=\"Send follow-up\"");
  });

  it("renders the follow-up mode chooser chevron alongside the send button", () => {
    const markup = renderToStaticMarkup(createElement(ComposerSendButton, {
      compact: true,
      label: "Send into the running turn",
      title: "Send into the running turn",
      look: { className: "bg-accent text-accent-ink" },
      disabled: false,
      onSend: vi.fn(),
      onChoose: vi.fn(),
      menu: {
        choices: ["steer", "queue", "restart"],
        name: "Pepper",
        sendKey: "Enter",
        alternateKey: "Ctrl+Enter",
      },
    }));

    expect(markup).toContain("data-composer-follow-up");
    expect(markup).toContain("aria-label=\"Choose how to send this message\"");
    expect(markup).toContain("lucide-arrow-up");
  });
});
