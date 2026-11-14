import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@ladybug/mascot/garden.css";
import App from "./App.tsx";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
