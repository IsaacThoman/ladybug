import { useCallback } from "react";
import { artifactUrl } from "../api.ts";
import { useLiveScan } from "../useLiveScan.ts";
import ErrorState from "./ErrorState.tsx";
import Header from "./Header.tsx";
import ReportView from "./ReportView.tsx";

export default function LiveScanPage({ scanId }: { scanId: string }) {
  const { scan, connection, failure } = useLiveScan(scanId);
  const artifactSrc = useCallback((key: string) => artifactUrl(scanId, key), [scanId]);

  const loaded = scan.inputUrl !== "";
  if (failure && !loaded) return <ErrorState failure={failure} scanId={scanId} />;
  if (!loaded) {
    return (
      <>
        <Header />
        <main className="loading-state" aria-busy="true">
          <span className="spinner" aria-hidden="true" />
          Loading scan…
        </main>
      </>
    );
  }

  let notice = null;
  if (failure?.kind === "unreachable") {
    notice = <p className="notice warn">Lost contact with the server. Retrying…</p>;
  } else if (connection === "polling") {
    notice = <p className="notice">Live stream unavailable; checking for updates every few seconds.</p>;
  }

  return <ReportView scan={scan} artifactSrc={artifactSrc} notice={notice} />;
}
