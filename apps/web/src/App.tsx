import { useEffect } from "react";
import DemoPage from "./components/DemoPage.tsx";
import ErrorState from "./components/ErrorState.tsx";
import Home from "./components/Home.tsx";
import LiveScanPage from "./components/LiveScanPage.tsx";
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
      {route.name === "home" && <Home />}
      {route.name === "demo" && <DemoPage />}
      {route.name === "scan" && <LiveScanPage key={route.scanId} scanId={route.scanId} />}
      {route.name === "not_found" && <ErrorState failure={{ kind: "not_found", message: "Page not found" }} />}
    </div>
  );
}
