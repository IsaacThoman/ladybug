import type { ReactNode } from "react";
import { LadybugMark } from "@ladybug/mascot/react";
import Link from "./Link.tsx";

export default function Header({ children }: { children?: ReactNode }) {
  return (
    <header className="app-header">
      <Link href="/" className="brand" aria-label="ladybug home">
        <LadybugMark size={30} className="brand-mark" />
        <span className="brand-name">ladybug</span>
      </Link>
      <div className="app-header-actions">{children}</div>
    </header>
  );
}
