import { Cloud, Hills } from "@ladybug/mascot/web";
import Link from "./Link.tsx";

export function Clouds() {
  return (
    <div className="clouds" aria-hidden="true">
      <Cloud className="cloud-shape cloud-a" />
      <Cloud className="cloud-shape cloud-b" />
      <Cloud className="cloud-shape cloud-c" />
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="meadow">
      <div className="site-footer">
        <span>ladybug · checks links in a disposable sandbox</span>
        <nav className="site-footer-links" aria-label="Footer">
          <Link href="/">Scan a link</Link>
          <Link href="/demo">Demo scan</Link>
        </nav>
      </div>
    </footer>
  );
}

/** The bottom of every page but home: hills, then the meadow footer. */
export function PageEnd() {
  return (
    <div className="page-end">
      <Hills className="hills" />
      <SiteFooter />
    </div>
  );
}
