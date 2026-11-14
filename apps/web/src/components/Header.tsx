import type { ReactNode } from "react";
import { ladybugSnapshot } from "@ladybug/garden";
import Link from "./Link.tsx";

export default function Header({ children }: { children?: ReactNode }) {
  return (
    <header className="app-header">
      <Link href="/" className="brand" aria-label="ladybug home">
        <img src={ladybugSnapshot} alt="" width={34} height={34} />
        <span className="brand-name">ladybug</span>
      </Link>
      <div className="app-header-actions">{children}</div>
    </header>
  );
}
