import { useCallback, useEffect, useState } from "react";
import type { AccountStatus, AdminAccount } from "@ladybug/shared";
import { api } from "../api";
import { formatFull, timeAgo } from "../format";
import Badge from "./Badge";

const STATUS_BADGE: Record<AccountStatus, { tone: "good" | "warning" | "critical"; icon: "check" | "clock" | "x"; label: string }> = {
  approved: { tone: "good", icon: "check", label: "Approved" },
  pending: { tone: "warning", icon: "clock", label: "Waiting" },
  rejected: { tone: "critical", icon: "x", label: "Turned down" },
};

const at = (iso: string) => new Date(iso).getTime();

export default function UsersView({ version }: { version: number }) {
  const [accounts, setAccounts] = useState<AdminAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .users()
      .then((res) => {
        if (cancelled) return;
        setAccounts(res.accounts);
        setError(null);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [version, reload]);

  const act = useCallback(async (action: () => Promise<unknown>) => {
    try {
      await action();
      setReload((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const pending = accounts?.filter((account) => account.status === "pending") ?? [];
  const others = accounts?.filter((account) => account.status !== "pending") ?? [];

  return (
    <div className="stack">
      <section className="card">
        <h2>Waiting for approval</h2>
        <p className="hint">
          People who signed up from the extension, the pet or the website. Until you approve them they can sign in,
          but nothing they visit is checked and their pet gets no alerts.
        </p>
        {error && <p className="form-error">{error}</p>}
        {accounts === null ? (
          <p className="empty">Loading…</p>
        ) : pending.length === 0 ? (
          <p className="empty">Nobody is waiting.</p>
        ) : (
          <ul className="requests">
            {pending.map((account) => (
              <li key={account.id}>
                <span className="request-name">{account.username}</span>
                <span className="muted" title={formatFull(at(account.createdAt))}>
                  signed up {timeAgo(at(account.createdAt))}
                </span>
                <span className="actions">
                  <button type="button" className="small" onClick={() => act(() => api.approveUser(account.id))}>
                    Approve
                  </button>
                  <button type="button" className="danger small" onClick={() => act(() => api.rejectUser(account.id))}>
                    Turn down
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Accounts</h2>
        <p className="hint">
          Calls let someone's pet ring the emergency contact when they pick Request help. They stay off until you
          turn them on, and turning them off hangs up a call in progress.
        </p>
        {others.length === 0 ? (
          <p className="empty">{accounts === null ? "Loading…" : "No accounts yet."}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Username</th>
                  <th>Signed up</th>
                  <th>Last seen</th>
                  <th>Devices</th>
                  <th>Calls</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {others.map((account) => {
                  const badge = STATUS_BADGE[account.status];
                  return (
                    <tr key={account.id}>
                      <td>
                        <Badge tone={badge.tone} icon={badge.icon} label={badge.label} />
                      </td>
                      <td>{account.username}</td>
                      <td className="muted" title={formatFull(at(account.createdAt))}>
                        {timeAgo(at(account.createdAt))}
                      </td>
                      <td className="muted" title={account.lastSeenAt ? formatFull(at(account.lastSeenAt)) : undefined}>
                        {account.lastSeenAt ? timeAgo(at(account.lastSeenAt)) : "Never"}
                      </td>
                      <td className="num">{account.sessions}</td>
                      <td className="muted">{account.callsEnabled ? "On" : "Off"}</td>
                      <td className="actions">
                        {account.status === "approved" && (
                          <button
                            type="button"
                            className="secondary small"
                            onClick={() => act(() => api.setUserCalls(account.id, !account.callsEnabled))}
                          >
                            {account.callsEnabled ? "Turn off calls" : "Turn on calls"}
                          </button>
                        )}
                        {account.status === "approved" ? (
                          <button
                            type="button"
                            className="secondary small"
                            onClick={() => {
                              if (confirm(`Revoke ${account.username}'s access? Their extension and pet stop working.`)) {
                                void act(() => api.rejectUser(account.id));
                              }
                            }}
                          >
                            Revoke access
                          </button>
                        ) : (
                          <button type="button" className="secondary small" onClick={() => act(() => api.approveUser(account.id))}>
                            Approve
                          </button>
                        )}
                        <button
                          type="button"
                          className="danger small"
                          onClick={() => {
                            if (confirm(`Delete ${account.username}? They can sign up again with the same name.`)) {
                              void act(() => api.deleteUser(account.id));
                            }
                          }}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
