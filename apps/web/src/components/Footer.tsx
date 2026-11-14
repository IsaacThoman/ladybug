import { GardenHills } from "@ladybug/mascot/react";

/** The ground the whole site stands on. */
export default function Footer() {
  return (
    <footer className="site-footer">
      <GardenHills />
      <div className="site-footer-bar">
        <span>made with 🪱 @ emory hacks 2026</span>
      </div>
    </footer>
  );
}
