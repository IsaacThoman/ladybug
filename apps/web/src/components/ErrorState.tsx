import { Ladybug, SpeechBubble } from "@ladybug/garden";
import type { ApiFailure } from "../api.ts";
import Header from "./Header.tsx";
import Link from "./Link.tsx";

export default function ErrorState({ failure, scanId }: { failure: ApiFailure; scanId?: string }) {
  const { title, body, say } = describe(failure, scanId);
  return (
    <>
      <Header />
      <main className="error-state">
        <div className="error-card panel">
          <Ladybug className="card-bug" mood="nervous" size={96} wander={50}>
            <SpeechBubble text={say} tone="warn" />
          </Ladybug>
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
        title: scanId ? "Scan not found" : "Page not found",
        body: scanId
          ? `There's no scan with id ${scanId}. It may have been typed wrong or expired.`
          : "That page doesn't exist.",
        say: "Nothing growing here…",
      };
    case "unreachable":
      return {
        title: "Can't reach the ladybug server",
        body: "The API didn't respond. Check that the server is running, then refresh this page.",
        say: "Hello? Server?",
      };
    case "unauthorized":
      return { title: "API key required", body: failure.message, say: "I need a key for this." };
    case "rate_limited":
      return { title: "Slow down", body: failure.message, say: "Phew, give me a sec!" };
    case "http":
      return { title: "Something went wrong", body: failure.message, say: "Uh oh." };
  }
}
