import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { GardenHills, MascotStage } from "@ladybug/mascot/react";
import type { LadybugMascotHandle, LadybugMood } from "@ladybug/mascot/react";
import { api } from "../api";

/** How long the ladybug celebrates before the dashboard opens. */
const WELCOME_MS = 900;

type Props = {
  onSignedIn: () => void;
  /** The server didn't answer the session check. */
  unreachable?: boolean;
  onRetry?: () => void;
};

export default function LoginPage({ onSignedIn, unreachable = false, onRetry }: Props) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [welcome, setWelcome] = useState(false);
  const mascotRef = useRef<LadybugMascotHandle>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      setWelcome(true);
      mascotRef.current?.celebrate();
      window.setTimeout(onSignedIn, WELCOME_MS);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
      mascotRef.current?.startle();
      inputRef.current?.select();
    }
  };

  let mood: LadybugMood = "calm";
  let says = "Hello! Who goes there?";
  if (unreachable) [mood, says] = ["nervous", "I can't reach the server."];
  else if (welcome) [mood, says] = ["happy", "Come on in!"];
  else if (busy) [mood, says] = ["sniffing", "Let me check…"];
  else if (error) [mood, says] = ["nervous", "Hmm, that's not it."];
  else if (password) [mood, says] = ["expectant", "Mm-hm…"];

  return (
    <div className="login garden-sky">
      <div className="garden-clouds" aria-hidden="true" />
      <main className="login-main">
        <MascotStage unit={150} mood={mood} ref={mascotRef}>
          <p className="mascot-bubble" key={mood} aria-hidden="true">
            {says}
          </p>
        </MascotStage>

        {unreachable ? (
          <section className="login-card">
            <h1>Computerbug admin</h1>
            <p className="login-sub">The server didn't answer. Check that it's running, then try again.</p>
            <button type="button" className="login-submit" onClick={onRetry}>
              Try again
            </button>
          </section>
        ) : (
          <form className="login-card" onSubmit={submit}>
            <h1>Computerbug admin</h1>
            <p className="login-sub">Sign in to tend the garden.</p>
            {/* Lets password managers file the password under a name. */}
            <input type="text" name="username" value="admin" autoComplete="username" readOnly hidden />
            <label className="login-field">
              <span>Admin password</span>
              <input
                ref={inputRef}
                type="password"
                name="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError(null);
                }}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "login-error" : undefined}
                readOnly={busy}
                autoFocus
                required
              />
            </label>
            {error && (
              <p className="form-error" id="login-error" role="alert">
                {error}
              </p>
            )}
            <button type="submit" className="login-submit" disabled={busy || !password}>
              {welcome ? "Welcome back" : busy ? "Checking…" : "Sign in"}
            </button>
          </form>
        )}
        <a className="login-back" href="/">
          ← Back to computerbug
        </a>
      </main>
      <GardenHills />
    </div>
  );
}
