import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { AdminModelSettings } from "@ladybug/shared";
import { api } from "../api";
import { formatFull, timeAgo } from "../format";
import Badge from "./Badge";

/** The select's value for "use the worker's LLM_MODEL". */
const DEFAULT = "";

export default function SettingsView({ version }: { version: number }) {
  return (
    <div className="stack">
      <ModelSetting version={version} />
    </div>
  );
}

function ModelSetting({ version }: { version: number }) {
  const [settings, setSettings] = useState<AdminModelSettings | null>(null);
  const [choice, setChoice] = useState(DEFAULT);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .modelSettings()
      .then((s) => {
        if (cancelled) return;
        setSettings(s);
        setChoice(s.selected ?? DEFAULT);
        setError(null);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [version]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const next = await api.setModel(choice === DEFAULT ? null : choice);
      setSettings(next);
      setChoice(next.selected ?? DEFAULT);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const catalog = settings?.catalog ?? null;
  const fallback = catalog?.defaultModel ?? null;
  const inUse = settings?.selected ?? fallback;
  // Still offer the current pick if the endpoint stopped listing it, so the select shows the truth.
  const missing = settings?.selected && catalog && !catalog.models.includes(settings.selected) ? settings.selected : null;
  const unchanged = choice === (settings?.selected ?? DEFAULT);

  return (
    <section className="card">
      <h2>Scan model</h2>
      <p className="hint">
        The model that investigates each page in the sandbox. Pick any model the worker's endpoint offers; the next
        scan uses it.
      </p>

      {settings === null ? (
        error ? null : <p className="empty">Loading…</p>
      ) : catalog === null ? (
        <p className="empty">
          No worker has reported its models. Start a worker with <code className="mono">LLM_API_KEY</code> set and they
          show up here.
        </p>
      ) : (
        <>
          <div className="setting-current">
            {inUse ? (
              <>
                <Badge tone="good" icon="check" label="In use" />
                <span className="mono">{inUse}</span>
                {!settings.selected && <span className="muted">(the worker's default)</span>}
              </>
            ) : (
              <>
                <Badge tone="warning" icon="alert" label="No model" />
                <span>Pick one, or scans use hard signals only.</span>
              </>
            )}
          </div>

          <form className="inline-form" onSubmit={submit}>
            <select
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              aria-label="Scan model"
              disabled={catalog.models.length === 0 && !missing}
            >
              <option value={DEFAULT}>Default{fallback ? `: ${fallback}` : " (none set)"}</option>
              {missing && <option value={missing}>{missing} (no longer offered)</option>}
              {catalog.models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
            <button type="submit" disabled={busy || unchanged}>
              {busy ? "Saving…" : "Save"}
            </button>
          </form>

          {catalog.error && (
            <p className="form-error">
              Listing models at {catalog.baseUrl} failed: {catalog.error}
            </p>
          )}
          {missing && (
            <p className="form-error">
              {missing} isn't offered by the endpoint anymore, so scans may fall back to hard signals.
            </p>
          )}
          <p className="setting-meta muted">
            {catalog.models.length} model{catalog.models.length === 1 ? "" : "s"} at{" "}
            <span className="mono">{catalog.baseUrl}</span>, listed{" "}
            <span title={formatFull(catalog.fetchedAt)}>{timeAgo(catalog.fetchedAt)}</span>. The default comes from the
            worker's <code className="mono">LLM_MODEL</code>.
          </p>
        </>
      )}
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}
