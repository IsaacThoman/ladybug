import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@ladybug/mascot/garden.css";
import App from "./App.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
