import type { ApiFailure } from "../api.ts";
import Header from "./Header.tsx";
import Link from "./Link.tsx";

export default function ErrorState({ failure, scanId }: { failure: ApiFailure; scanId?: string }) {
  const { title, body } = describe(failure, scanId);
  return (
    <>
      <Header />
      <main className="error-state">
        <div className="error-card panel">
          <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden="true">
            <circle cx="28" cy="28" r="26" fill="none" stroke="currentColor" strokeWidth="3" opacity="0.35" />
            <path d="M28 15v17" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
            <circle cx="28" cy="40" r="2.6" fill="currentColor" />
          </svg>
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
        title: "Can't reach the ladybugg server",
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
