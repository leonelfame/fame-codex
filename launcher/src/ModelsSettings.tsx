import { useState } from "react";
import type { LauncherApi } from "./types";

type DetectionState =
  | { status: "idle" | "checking" }
  | { status: "complete"; capabilities: Awaited<ReturnType<LauncherApi["refreshModels"]>> }
  | { status: "error"; message: string };

export function ModelsSettings({ api, enabled, automatic }: {
  api: Pick<LauncherApi, "refreshModels">;
  enabled: boolean;
  automatic: boolean;
}) {
  const [detection, setDetection] = useState<DetectionState>({ status: "idle" });
  const checking = detection.status === "checking";
  const detect = async () => {
    if (checking) return;
    setDetection({ status: "checking" });
    try {
      setDetection({ status: "complete", capabilities: await api.refreshModels() });
    } catch (error) {
      setDetection({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };
  return <section className="updates-settings" aria-labelledby="models-settings-title" aria-busy={checking}>
    <div className="setting-row">
      <div>
        <h2 id="models-settings-title">ChatGPT models</h2>
        <p>Detect models from your signed-in account and refresh the catalog without stopping the bridge.</p>
      </div>
      <button className="button-secondary" type="button" disabled={checking || !enabled || !automatic}
        onClick={() => void detect()}>
        {checking ? "Detecting models…" : "Detect models again"}
      </button>
    </div>
    <div className="updates-result" aria-live="polite" aria-atomic="true">
      {detection.status === "complete" ? <>
        <p>Detected: {[
          detection.capabilities.solAvailable ? "Sol (Web)" : "Luna (Web)",
          ...(detection.capabilities.extraHighAvailable ? ["Extra High"] : []),
          ...(detection.capabilities.proAvailable ? ["Pro (Web)"] : []),
        ].join(" · ")}</p>
        <p>Saved and refreshed the bridge. Open a new Codex session to load the updated model list.</p>
      </> : null}
      {detection.status === "error" ? <p role="alert">Detection failed. Previous settings were kept. Check that ChatGPT is signed in and browser tasks have finished, then retry.
        {" "}{detection.message}</p> : null}
    </div>
    {!enabled || !automatic ? <p className="updates-hint">{!enabled ? "Complete Fame Codex setup before detecting models." : "Select With Automation to detect models from the web."}</p> : null}
  </section>;
}
