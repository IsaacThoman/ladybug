import type { ReactNode } from "react";
import LadybugMark from "./LadybugMark.tsx";
import Link from "./Link.tsx";

export default function Header({ children }: { children?: ReactNode }) {
  return (
    <header className="app-header">
      <Link href="/" className="brand" aria-label="ladybug home">
        <LadybugMark size={32} />
        <span className="brand-name">ladybug</span>
      </Link>
      <div className="app-header-actions">{children}</div>
    </header>
  );
}
