import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Cloud, Hills, Mascot } from "@ladybug/mascot/web";
import type { LadybugMood, MascotHandle, MascotLook } from "@ladybug/mascot/web";
import type { AdminSession } from "@ladybug/shared";
import { ApiError, api } from "../api";
import LadybugMark from "./LadybugMark";

type Status = "idle" | "checking" | "wrong" | "limited" | "offline" | "welcome";

/** Long enough for the happy hop before the dashboard replaces the page. */
const WELCOME_MS = 1100;
/** Turned politely away while a hidden password is typed. */
const LOOK_AWAY: MascotLook = { x: 0.95, y: -0.4 };
const LOOK_AT_FORM: MascotLook = { x: 0, y: 0.9 };

const OFFLINE_MESSAGE = "Can't reach the ladybug server. Is it running?";

export default function LoginPage({
  offline,
  onSignedIn,
}: {
  /** The session check couldn't reach the server. */
  offline: boolean;
  onSignedIn: (session: AdminSession) => void;
}) {
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [focused, setFocused] = useState(false);
  const [status, setStatus] = useState<Status>(offline ? "offline" : "idle");
  const [message, setMessage] = useState<string | null>(offline ? OFFLINE_MESSAGE : null);
  const mascot = useRef<MascotHandle>(null);
  const timer = useRef(0);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || status === "checking" || status === "welcome") return;
    setStatus("checking");
    setMessage(null);
    try {
      const session = await api.login(password);
      setStatus("welcome");
      mascot.current?.celebrate();
      timer.current = window.setTimeout(() => onSignedIn(session), WELCOME_MS);
    } catch (error) {
      if (error instanceof ApiError) {
        setStatus(error.status === 429 ? "limited" : "wrong");
        setMessage(error.message);
      } else {
        setStatus("offline");
        setMessage(OFFLINE_MESSAGE);
      }
      mascot.current?.startle();
    }
  };

  const typingSecret = focused && password !== "" && !reveal;
  let mood: LadybugMood = "calm";
  let look: MascotLook | "pointer" = "pointer";
  let bubble = "Hi! What's the password?";
  if (status === "welcome") {
    mood = "happy";
    bubble = "Welcome back!";
  } else if (status === "checking") {
    mood = "sniffing";
    look = LOOK_AT_FORM;
    bubble = "Checking…";
  } else if (status === "wrong" || status === "limited" || status === "offline") {
    mood = "nervous";
    bubble =
      status === "wrong" ? "Hmm, that's not it." : status === "limited" ? "Let's take a little break." : "I can't reach the server.";
  } else if (typingSecret) {
    look = LOOK_AWAY;
    bubble = "No peeking, promise.";
  } else if (focused && reveal && password) {
    look = LOOK_AT_FORM;
    bubble = "Ooh, I can see it now.";
  }

  return (
    <div className="login">
      <div className="clouds" aria-hidden="true">
        <Cloud className="cloud-shape cloud-a" />
        <Cloud className="cloud-shape cloud-b" />
        <Cloud className="cloud-shape cloud-c" />
      </div>
      <main className="login-main">
        <div className="login-mascot">
          <p className="bubble" data-tone={mood === "nervous" ? "warn" : undefined} aria-hidden="true" key={bubble}>
            {bubble}
          </p>
          <Mascot
            ref={mascot}
            mood={mood}
            look={look}
            fallback={
              <span className="mascot-fallback">
                <LadybugMark size={96} />
              </span>
            }
          />
        </div>
        <form className="login-card" onSubmit={submit} noValidate>
          <h1 className="login-title">
            ladybug <span className="brand-tag">admin</span>
          </h1>
          <p className="login-sub">Enter the admin password to see what the pets have been up to.</p>
          <label className="login-label" htmlFor="admin-password">
            Password
          </label>
          <div className="password-field" data-invalid={status === "wrong" || undefined}>
            <input
              id="admin-password"
              type={reveal ? "text" : "password"}
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (status === "wrong") setStatus("idle");
              }}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              aria-invalid={status === "wrong" || undefined}
              aria-describedby={message ? "login-message" : undefined}
              disabled={status === "welcome"}
            />
            <button
              type="button"
              className="reveal"
              onClick={() => setReveal((v) => !v)}
              aria-pressed={reveal}
              aria-label={reveal ? "Hide password" : "Show password"}
            >
              {reveal ? "Hide" : "Show"}
            </button>
          </div>
          {message && (
            <p id="login-message" className="form-error" role="alert">
              {message}
            </p>
          )}
          <button
            type="submit"
            className="login-submit"
            data-done={status === "welcome" || undefined}
            disabled={!password || status === "checking" || status === "welcome"}
          >
            {status === "checking" ? "Checking…" : status === "welcome" ? "Signed in" : "Sign in"}
          </button>
        </form>
      </main>
      <Hills className="login-hills" />
    </div>
  );
}
