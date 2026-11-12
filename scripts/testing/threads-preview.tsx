import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { setAnalyticsEnabled, setEmailGateDone } from "../../src/lib/analytics";
import { setAdvancedMode } from "../../src/lib/interface-mode";
import { GROK_MOVE_NOTICE, MODELGO_OFFER_NOTICE } from "../../src/lib/notices";
import { markSimpleModePromptSeen } from "../../src/lib/simple-mode-prompt";
import { applySkinChoice, readSkinChoice } from "../../src/lib/skins";
import "../../src/styles.css";

// This entry point is served only by the disposable verification launcher.
const query = new URLSearchParams(location.search);
// The voice-latency harness opts in with ?ombVoiceProbe=1; the recorder in
// src/lib/voice-latency-probe stays inert without this sink.
if (query.has("ombVoiceProbe")) {
  (window as typeof window & { __ombVoiceProbe?: unknown[] }).__ombVoiceProbe = [];
}
setAnalyticsEnabled(false);
// ?onboarding=1 plays a brand-new install with the default interface mode.
if (query.get("fixtureMode") === "simple") setAdvancedMode(false);
if (!query.has("onboarding")) setEmailGateDone("skipped");
// Every launch is a new browser, so the once-per-browser Simple mode popup shows only with ?simpleModePrompt=1.
if (!query.has("simpleModePrompt")) markSimpleModePromptSeen();
// The same for the once-per-person Move from Grok Bot popup, with ?grokMovePopup=1.
if (!query.has("grokMovePopup")) localStorage.setItem(GROK_MOVE_NOTICE, "1");
if (!query.has("modelgoOffer")) localStorage.setItem(MODELGO_OFFER_NOTICE, "1");
applySkinChoice(readSkinChoice());
createRoot(document.getElementById("root")!).render(<App />);
