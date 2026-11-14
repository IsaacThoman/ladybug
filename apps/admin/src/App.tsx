import { useCallback, useEffect, useState } from "react";
import { SIGNED_OUT, api } from "./api";
import Dashboard from "./components/Dashboard";
import LoginPage from "./components/LoginPage";

type Session =
  | { state: "loading" }
  | { state: "unreachable" }
  | { state: "signed-out" }
  | { state: "signed-in"; canSignOut: boolean };

const BASE = "/admin/";
const LOGIN_PATH = `${BASE}login`;

/** Show /admin/login while signed out, and send people back where they were after. */
function syncPath(signedIn: boolean) {
  const { pathname, hash } = window.location;
  const onLogin = pathname.replace(/\/+$/, "") === LOGIN_PATH;
  if (signedIn && onLogin) window.history.replaceState(null, "", `${BASE}${hash}`);
  if (!signedIn && !onLogin) window.history.replaceState(null, "", `${LOGIN_PATH}${hash}`);
}

export default function App() {
  const [session, setSession] = useState<Session>({ state: "loading" });

  const check = useCallback(() => {
    api
      .session()
      .then((s) =>
        setSession(s.authenticated ? { state: "signed-in", canSignOut: s.required } : { state: "signed-out" }),
      )
      .catch(() => setSession({ state: "unreachable" }));
  }, []);

  useEffect(check, [check]);

  useEffect(() => {
    const onSignedOut = () => setSession({ state: "signed-out" });
    window.addEventListener(SIGNED_OUT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT, onSignedOut);
  }, []);

  useEffect(() => {
    if (session.state === "signed-in" || session.state === "signed-out") syncPath(session.state === "signed-in");
  }, [session.state]);

  const signOut = useCallback(() => {
    void api.logout().finally(() => setSession({ state: "signed-out" }));
  }, []);

  switch (session.state) {
    case "loading":
      return <div className="splash garden-sky" aria-busy="true" />;
    case "unreachable":
      return <LoginPage unreachable onRetry={check} onSignedIn={check} />;
    case "signed-out":
      return <LoginPage onSignedIn={() => setSession({ state: "signed-in", canSignOut: true })} />;
    case "signed-in":
      return <Dashboard onSignOut={session.canSignOut ? signOut : undefined} />;
  }
}
