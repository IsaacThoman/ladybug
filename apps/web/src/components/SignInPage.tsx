import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { MascotStage } from "@ladybug/mascot/react";
import type { LadybugMascotHandle, LadybugMood } from "@ladybug/mascot/react";
import { ApiRequestError, createScan, signIn } from "../api.ts";
import { navigate } from "../router.ts";
import { getSession } from "../session.ts";
import Link from "./Link.tsx";

/** How long the ladybug celebrates before moving on. */
const WELCOME_MS = 700;

/** The link someone tried to scan while signed out, carried as ?url=. */
const pendingUrl = () => new URLSearchParams(window.location.search).get("url");

/**
 * Sign in or create an account. Afterwards an approved account goes straight
 * on to scan the link it came with; everyone else goes back home.
 */
export default function SignInPage() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [welcome, setWelcome] = useState(false);
  const mascotRef = useRef<LadybugMascotHandle>(null);
  const [url] = useState(pendingUrl);
  const signup = mode === "signup";

  // Already signed in: nothing to do here.
  useEffect(() => {
    if (getSession()) navigate("/");
  }, []);

  const finish = async () => {
    const session = getSession();
    if (url && session?.account.status === "approved") {
      try {
        const { scanId } = await createScan(url);
        navigate(`/scans/${scanId}`);
        return;
      } catch {
        // Fall back to the home page with the link filled in.
      }
    }
    navigate(url ? `/?url=${encodeURIComponent(url)}` : "/");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(mode, username, password);
      setWelcome(true);
      mascotRef.current?.celebrate();
      window.setTimeout(() => void finish(), WELCOME_MS);
    } catch (err) {
      setBusy(false);
      setError(
        err instanceof ApiRequestError && err.failure.kind === "unreachable"
          ? "Can't reach the ladybugg server."
          : err instanceof Error
            ? err.message
            : String(err),
      );
      mascotRef.current?.startle();
    }
  };

  let mood: LadybugMood = "calm";
  let says = signup ? "A new friend! Pick a name." : "Hello! Who goes there?";
  if (welcome) [mood, says] = ["happy", signup ? "Welcome to the garden!" : "Come on in!"];
  else if (busy) [mood, says] = ["sniffing", "Let me check…"];
  else if (error) [mood, says] = ["nervous", "Hmm, that didn't work."];

  return (
    <main className="signin">
      <MascotStage unit={150} mood={mood} ref={mascotRef}>
        <p className="mascot-bubble" key={`${mood}:${says}`} aria-hidden="true">
          {says}
        </p>
      </MascotStage>

      <form className="signin-card" onSubmit={submit}>
        <h1>{signup ? "Create an account" : "Sign in"}</h1>
        <p className="signin-sub">
          {url
            ? "Sign in to scan that link."
            : signup
              ? "An admin approves new accounts before they can scan."
              : "Scan links, and let your ladybug warn you."}
        </p>
        <label className="signin-field">
          <span>Username</span>
          <input
            name="username"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              setError(null);
            }}
            autoComplete="username"
            autoCapitalize="off"
            spellCheck={false}
            readOnly={busy}
            autoFocus
            required
          />
        </label>
        <label className="signin-field">
          <span>Password</span>
          <input
            type="password"
            name="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(null);
            }}
            autoComplete={signup ? "new-password" : "current-password"}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "signin-error" : undefined}
            readOnly={busy}
            required
          />
        </label>
        {error && (
          <p className="form-error" id="signin-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="button primary signin-submit" disabled={busy || !username || !password}>
          {welcome ? "Welcome" : busy ? "Checking…" : signup ? "Create account" : "Sign in"}
        </button>
        <p className="signin-switch">
          {signup ? "Already have an account?" : "New here?"}{" "}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setMode(signup ? "login" : "signup");
              setError(null);
            }}
          >
            {signup ? "Sign in" : "Create an account"}
          </button>
        </p>
      </form>
      <Link href="/" className="signin-back">
        ← Back to ladybugg
      </Link>
    </main>
  );
}
