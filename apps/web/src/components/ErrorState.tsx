import { Mascot } from "@ladybug/mascot/web";
import type { ApiFailure } from "../api.ts";
import { PageEnd } from "./Garden.tsx";
import Header from "./Header.tsx";
import LadybugMark from "./LadybugMark.tsx";
import Link from "./Link.tsx";

export default function ErrorState({ failure, scanId }: { failure: ApiFailure; scanId?: string }) {
  const { title, body } = describe(failure, scanId);
  return (
    <>
      <Header />
      <main className="error-state">
        <div className="error-card">
          <div className="state-mascot">
            <Mascot mood="nervous" fallback={<LadybugMark size={96} />} />
          </div>
          <h1>{title}</h1>
          <p>{body}</p>
          <div className="error-actions">
            <Link href="/" className="button primary">
              Scan another URL
            </Link>
            <Link href="/demo" className="button ghost">
              Watch the demo
            </Link>
          </div>
        </div>
      </main>
      <PageEnd />
    </>
  );
}

function describe(failure: ApiFailure, scanId?: string) {
  switch (failure.kind) {
    case "not_found":
      return {
        title: "Scan not found",
        body: scanId
          ? `There's no scan with id ${scanId}. It may have been typed wrong or expired.`
          : "That page doesn't exist.",
      };
    case "unreachable":
      return {
        title: "Can't reach the ladybug server",
        body: "The API didn't respond. Check that the server is running, then refresh this page.",
      };
    case "unauthorized":
      return { title: "API key required", body: failure.message };
    case "rate_limited":
      return { title: "Slow down", body: failure.message };
    case "http":
      return { title: "Something went wrong", body: failure.message };
  }
}
