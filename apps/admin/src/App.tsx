import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminSession } from "@ladybug/shared";
import { api, setUnauthorizedHandler } from "./api";
import Dashboard from "./components/Dashboard";
import LoginPage from "./components/LoginPage";

const HOME_PATH = "/admin/";
const LOGIN_PATH = "/admin/login";

type Gate =
  | { state: "checking" }
  | { state: "in"; passwordRequired: boolean }
  | { state: "out"; offline?: boolean };

const onLoginPath = () => window.location.pathname.replace(/\/+$/, "") === LOGIN_PATH;
const gateFor = (session: AdminSession): Gate =>
  session.authenticated ? { state: "in", passwordRequired: session.required } : { state: "out" };

/** Shows the login page at /admin/login until the admin API lets us in, then the dashboard. */
export default function App() {
  const [gate, setGate] = useState<Gate>({ state: "checking" });
  // The tab to return to after logging in.
  const returnHash = useRef(onLoginPath() ? "" : window.location.hash);

  const check = useCallback(() => {
    api
      .session()
      .then((session) => setGate(gateFor(session)))
      .catch(() => setGate({ state: "out", offline: true }));
  }, []);

  useEffect(check, [check]);

  useEffect(() => {
    setUnauthorizedHandler(() => setGate({ state: "out" }));
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    if (gate.state === "out") {
      document.title = "Sign in · ladybug admin";
      if (!onLoginPath()) {
        returnHash.current = window.location.hash;
        window.history.replaceState(null, "", LOGIN_PATH);
      }
    } else if (gate.state === "in") {
      document.title = "ladybug admin";
      if (onLoginPath()) window.history.replaceState(null, "", HOME_PATH + returnHash.current);
    }
  }, [gate.state]);

  const signOut = useCallback(() => {
    api
      .logout()
      .catch(() => undefined)
      .finally(() => setGate({ state: "out" }));
  }, []);

  if (gate.state === "checking") return <div className="app-loading" aria-busy="true" />;
  if (gate.state === "out") {
    return <LoginPage offline={gate.offline ?? false} onSignedIn={(session) => setGate(gateFor(session))} />;
  }
  return <Dashboard passwordRequired={gate.passwordRequired} onSignOut={signOut} />;
}
