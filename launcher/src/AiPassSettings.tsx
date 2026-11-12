import { useEffect, useState } from "react";
import type { AiPassStatus, Language, LauncherApi } from "./types";

export function AiPassSettings({ api }: { api: LauncherApi; language: Language }) {
  const [state, setState] = useState<AiPassStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void api.getAiPassStatus?.().then(value => { if (active) setState(value); })
      .catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [api]);
  const run = async (operation: () => Promise<AiPassStatus | boolean> | undefined) => {
    setBusy(true);
    setError(null);
    try {
      const result = await operation();
      if (typeof result === "object") setState(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const status = !state ? "Reading status..."
    : !state.enabled ? "Disabled"
    : state.status === "error" ? "Bridge error"
    : state.extensionConnected ? "Extension connected"
    : state.status === "running" ? "Waiting for extension"
    : "Bridge stopped";
  const bridgeError = state?.error === "port_unavailable"
    ? ("Port 17843 is in use. Other processes are left running.")
    : state?.error === "refresh_failed"
      ? "TH AI Pass model refresh failed. Open the signed-in chat tab, reload the extension, and try again."
    : state?.error;
  return <section className="aipass-settings" aria-labelledby="aipass-heading" aria-busy={busy}>
    <div className="setting-row">
      <div>
        <strong id="aipass-heading">TH AI Pass <span className="aipass-badge">{"Experimental"}</span></strong>
        <p>{"Use models from TH AI Pass through its browser extension."}</p>
      </div>
      <button type="button" role="switch" aria-checked={state?.enabled ?? false}
        aria-label={"Enable TH AI Pass"}
        className={`switch${state?.enabled ? " is-on" : ""}`}
        disabled={busy || !state || !api.setAiPassEnabled}
        onClick={() => void run(() => api.setAiPassEnabled?.(!state?.enabled))}><span aria-hidden="true">{state?.enabled ? "[x]" : "[ ]"}</span></button>
    </div>
    <p role="status" aria-live="polite">{status} | 127.0.0.1:17843 | Limited context</p>
    {error || bridgeError ? <p className="aipass-error" role="alert">{error || bridgeError}</p> : null}
    <ol>
      <li>{"Open Chrome or Edge extensions and turn on Developer mode."}</li>
      <li>{"Choose Load unpacked and select the extension folder opened below."}</li>
      <li>{"Open TH AI Pass, sign in, then refresh models. If the extension is already loaded, start here."}</li>
    </ol>
    <div className="aipass-actions">
      <button type="button" disabled={busy || !api.openAiPassExtensionFolder} onClick={() => void run(() => api.openAiPassExtensionFolder?.())}>
        {"Open extension folder"}</button>
      <button type="button" disabled={busy || !api.openAiPassWebsite} onClick={() => void run(() => api.openAiPassWebsite?.())}>
        {"Open TH AI Pass"}</button>
      <button type="button" disabled={busy || !state?.enabled || !api.refreshAiPassModels} onClick={() => void run(() => api.refreshAiPassModels?.())}>
        {busy ? "Working..." : "Refresh models"}</button>
    </div>
    {state?.extensionConnected && state.models.length > 0
      ? <ul className="aipass-models" aria-label={"Connected models"}>
        {state.models.map(model => <li key={model.id}>{model.name} <code>{model.id}</code>
          {model.thinking?.length ? ` · Effort: ${model.thinking.join(", ")}` : " · Web default effort"}</li>)}
      </ul>
      : <p>{"No models loaded from a connected extension yet."}</p>}
    <p className="aipass-hint">{"Connection and model discovery do not verify a successful chat request."}</p>
    <p className="aipass-hint">{"Only supported text/chat models available to the signed-in TH AI Pass account are listed; image, video and other unsupported model categories are excluded."}</p>
  </section>;
}
