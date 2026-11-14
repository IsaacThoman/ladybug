import { useState } from "react";
import type { FormEvent } from "react";
import type { CheckResponse } from "@ladybug/shared";
import { api } from "../api";
import Badge, { VerdictBadge } from "./Badge";

/** Runs a URL through the same pipeline as a visit reported by the extension. */
export default function CheckForm() {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CheckResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(await api.check(url));
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Check a URL</h2>
      <p className="hint">Same as visiting it with the extension on, including the pet alert.</p>
      <form className="inline-form" onSubmit={submit}>
        <input
          type="text"
          placeholder="https://example.com/page"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
          spellCheck={false}
          aria-label="URL to check"
        />
        <button type="submit" disabled={busy}>
          {busy ? "Checking…" : "Check"}
        </button>
      </form>
      {error && <p className="form-error">{error}</p>}
      {result && (
        <div className="check-result">
          {result.status === "known" && (
            <>
              <VerdictBadge verdict={result.verdict} />
              <span>
                Known {result.record.scope === "host" ? `host (${result.record.host})` : "URL"}:{" "}
                {result.record.reason}
              </span>
            </>
          )}
          {result.status === "pending" && (
            <>
              <Badge tone="warning" icon="clock" label="Unknown" />
              <span>Analysing, done in about {Math.ceil(result.etaMs / 1000)}s.</span>
            </>
          )}
          {result.status === "skipped" && (
            <>
              <Badge tone="neutral" icon="minus" label="Skipped" />
              <span>{result.reason}</span>
            </>
          )}
        </div>
      )}
    </section>
  );
}
