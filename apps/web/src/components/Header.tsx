import type { ReactNode } from "react";
import { LadybugMark } from "@ladybug/mascot/react";
import { signOut } from "../api.ts";
import { usePathname } from "../router.ts";
import { useSession } from "../session.ts";
import Link from "./Link.tsx";

export default function Header({ children }: { children?: ReactNode }) {
  const session = useSession();
  const onSignIn = usePathname() === "/signin";
  return (
    <header className="app-header">
      <Link href="/" className="brand" aria-label="ladybugg home">
        <LadybugMark size={38} className="brand-mark" />
        <span className="brand-name">ladybugg</span>
      </Link>
      <div className="app-header-actions">
        {children}
        {session ? (
          <span className="header-account">
            <span className="header-user" title={`Signed in as ${session.account.username}`}>
              {session.account.username}
            </span>
            <button type="button" className="link-button" onClick={() => void signOut()}>
              Sign out
            </button>
          </span>
        ) : (
          !onSignIn && (
            <Link href="/signin" className="button primary small">
              Sign in
            </Link>
          )
        )}
      </div>
    </header>
  );
}
