import { useEffect } from "react";
import DemoPage from "./components/DemoPage.tsx";
import ErrorState from "./components/ErrorState.tsx";
import Footer from "./components/Footer.tsx";
import Header from "./components/Header.tsx";
import Home from "./components/Home.tsx";
import LiveScanPage from "./components/LiveScanPage.tsx";
import SignInPage from "./components/SignInPage.tsx";
import Link from "./components/Link.tsx";
import { matchRoute, usePathname } from "./router.ts";

const TITLES = {
  home: "ladybug",
  signin: "Sign in · ladybug",
  demo: "Demo scan · ladybug",
  scan: "Scan report · ladybug",
  not_found: "Not found · ladybug",
};

export default function App() {
  const route = matchRoute(usePathname());

  useEffect(() => {
    document.title = TITLES[route.name];
  }, [route.name]);

  return (
    <div className="app garden-sky">
      <div className="garden-clouds" aria-hidden="true" />
      {route.name === "home" && (
        <>
          <Header>
            <a href="#how" className="nav-link">
              How it works
            </a>
            <Link href="/demo" className="button ghost small">
              Watch a demo
            </Link>
          </Header>
          <Home />
        </>
      )}
      {route.name === "signin" && (
        <>
          <Header />
          <SignInPage />
        </>
      )}
      {route.name === "demo" && <DemoPage />}
      {route.name === "scan" && <LiveScanPage key={route.scanId} scanId={route.scanId} />}
      {route.name === "not_found" && <ErrorState failure={{ kind: "not_found", message: "Page not found" }} />}
      <Footer />
    </div>
  );
}
