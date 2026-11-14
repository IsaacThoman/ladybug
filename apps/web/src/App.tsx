import { useEffect } from "react";
import { Garden } from "@ladybug/garden";
import DemoPage from "./components/DemoPage.tsx";
import ErrorState from "./components/ErrorState.tsx";
import Header from "./components/Header.tsx";
import Home from "./components/Home.tsx";
import LiveScanPage from "./components/LiveScanPage.tsx";
import Link from "./components/Link.tsx";
import { matchRoute, usePathname } from "./router.ts";

const TITLES = {
  home: "ladybug",
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
    <div className="app">
      <Garden vines={route.name === "home"} />
      {route.name === "home" && (
        <>
          <Header>
            <a href="#how" className="link-button">
              How it works
            </a>
            <Link href="/demo" className="button ghost small">
              Demo
            </Link>
          </Header>
          <Home />
          <footer className="home-foot">
            <svg className="home-grass" viewBox="0 0 1200 90" preserveAspectRatio="none" aria-hidden="true">
              <path className="grass-back" d="M0 90V46C140 18 300 30 420 44s260 6 400-14 280-4 380 22v52Z" />
              <path className="grass-front" d="M0 90V62c160-26 320-14 470 0s300 10 450-10 200-6 280 8v30Z" />
            </svg>
            <p>
              <span className="hand">ladybug keeps an eye on links</span> ·{" "}
              <Link href="/demo">watch a recorded scan</Link>
            </p>
          </footer>
        </>
      )}
      {route.name === "demo" && <DemoPage />}
      {route.name === "scan" && <LiveScanPage key={route.scanId} scanId={route.scanId} />}
      {route.name === "not_found" && <ErrorState failure={{ kind: "not_found", message: "Page not found" }} />}
    </div>
  );
}
