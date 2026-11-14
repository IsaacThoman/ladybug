import { GardenHills } from "@ladybug/mascot/react";
import Link from "./Link.tsx";

/** The ground the whole site stands on. */
export default function Footer() {
  return (
    <footer className="site-footer">
      <GardenHills />
      <div className="site-footer-bar">
        <span>ladybugg keeps an eye on the links in your garden.</span>
        <nav aria-label="Footer">
          <Link href="/demo">Demo scan</Link>
          <a href="/admin/">Admin</a>
        </nav>
      </div>
    </footer>
  );
}
