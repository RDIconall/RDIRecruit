"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { APP } from "@/lib/triage/app-theme";
import type { HireInboxItem, HireInboxSummary } from "@/lib/hires/types";
import { markAllHiresReadAction, markHireReadAction } from "@/app/actions/hires";

type Filter = "unread" | "all";

function formatHiredAt(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function relativeHired(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days}d ago`;
  return formatHiredAt(iso);
}

export function HiresApp({ data }: { data: HireInboxSummary }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [filter, setFilter] = useState<Filter>(data.unread > 0 ? "unread" : "all");
  const [toast, setToast] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const items = useMemo(() => {
    return data.items.map((i) =>
      optimistic[i.candidateId] === undefined
        ? i
        : { ...i, read: optimistic[i.candidateId]! },
    );
  }, [data.items, optimistic]);

  const visible = useMemo(() => {
    if (filter === "unread") return items.filter((i) => !i.read);
    return items;
  }, [items, filter]);

  const unreadCount = items.filter((i) => !i.read).length;

  function setRead(ids: string[], read: boolean) {
    setOptimistic((prev) => {
      const next = { ...prev };
      for (const id of ids) next[id] = read;
      return next;
    });
    start(async () => {
      const res = await markHireReadAction({ candidateIds: ids, read });
      if (!res.ok) {
        flash(res.message ?? "Could not update read status");
        setOptimistic((prev) => {
          const next = { ...prev };
          for (const id of ids) delete next[id];
          return next;
        });
        return;
      }
      router.refresh();
    });
  }

  function markAll() {
    const unreadIds = items.filter((i) => !i.read).map((i) => i.candidateId);
    if (unreadIds.length === 0) return;
    setOptimistic((prev) => {
      const next = { ...prev };
      for (const id of unreadIds) next[id] = true;
      return next;
    });
    start(async () => {
      const res = await markAllHiresReadAction();
      if (!res.ok) {
        flash(res.message ?? "Could not mark all read");
        setOptimistic({});
        return;
      }
      flash(res.marked ? `Marked ${res.marked} read` : "All caught up");
      router.refresh();
    });
  }

  function openHire(item: HireInboxItem) {
    if (!item.read) setRead([item.candidateId], true);
    router.push(item.triageUrl);
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: APP.surface,
        fontFamily: APP.sans,
        color: APP.ink,
        fontSize: 16,
        lineHeight: 1.5,
        opacity: pending ? 0.85 : 1,
        transition: "opacity 120ms",
      }}
    >
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 40,
          height: 54,
          background: "rgba(255,255,255,0.92)",
          backdropFilter: "saturate(1.1) blur(6px)",
          borderBottom: `1px solid ${APP.hair}`,
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "0 28px",
        }}
      >
        <Link
          href="/"
          style={{
            fontWeight: 700,
            fontSize: 17,
            letterSpacing: "-0.02em",
            color: APP.ink,
            textDecoration: "none",
            flexShrink: 0,
          }}
        >
          RDIRecruit
        </Link>
        <div style={{ width: 1, height: 18, background: APP.hair }} />
        <Link
          href="/radar"
          style={{ fontSize: 13, color: APP.secondary, textDecoration: "none" }}
        >
          Talent Radar
        </Link>
        <span style={{ fontSize: 13, color: APP.ink, fontWeight: 600 }}>New Hires</span>
        <div style={{ flex: 1 }} />
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={markAll}
            disabled={pending}
            style={{
              fontFamily: APP.sans,
              fontSize: 13,
              color: APP.accent,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: "4px 0",
            }}
          >
            Mark all read
          </button>
        )}
      </div>

      {toast && (
        <div
          onClick={() => setToast(null)}
          style={{
            background: APP.accentSoft,
            borderBottom: `1px solid ${APP.accentBorder}`,
            color: APP.ink,
            fontFamily: APP.mono,
            fontSize: 12.5,
            padding: "8px 28px",
            cursor: "pointer",
          }}
        >
          {toast} <span style={{ color: APP.muted }}>· dismiss</span>
        </div>
      )}

      {!data.configured && (
        <div
          style={{
            padding: "12px 28px",
            background: APP.weakSoft,
            borderBottom: `1px solid ${APP.weakBorder}`,
            fontFamily: APP.mono,
            fontSize: 12.5,
            color: APP.weak,
          }}
        >
          Live data source not configured — hire inbox unavailable.
        </div>
      )}

      <div style={{ maxWidth: 880, margin: "0 auto", padding: "28px 28px 64px" }}>
        <header style={{ marginBottom: 22 }}>
          <h1
            style={{
              margin: 0,
              fontSize: 28,
              fontWeight: 700,
              letterSpacing: "-0.03em",
              lineHeight: 1.2,
            }}
          >
            New Hires
          </h1>
          <p style={{ margin: "8px 0 0", color: APP.secondary, fontSize: 15, maxWidth: 520 }}>
            Cross-job summary of everyone marked Hired. Unread items stay until you open or
            mark them read — like an inbox.
          </p>
        </header>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "baseline",
            gap: "10px 20px",
            marginBottom: 18,
            fontFamily: APP.mono,
            fontSize: 12.5,
            color: APP.secondary,
          }}
        >
          <span>
            <strong style={{ color: APP.ink, fontWeight: 600 }}>{unreadCount}</strong> unread
            <span style={{ color: APP.faint }}> · </span>
            {data.total} total
          </span>
          {data.unreadByJob.map((j) => (
            <span key={j.shortcode}>
              {j.title}{" "}
              <strong style={{ color: APP.ink, fontWeight: 600 }}>{j.count}</strong>
            </span>
          ))}
        </div>

        <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
          {(
            [
              ["unread", `Unread${unreadCount ? ` (${unreadCount})` : ""}`],
              ["all", "All"],
            ] as const
          ).map(([key, label]) => {
            const active = filter === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                style={{
                  fontFamily: APP.sans,
                  fontSize: 13,
                  fontWeight: active ? 600 : 400,
                  color: active ? APP.ink : APP.secondary,
                  background: "transparent",
                  border: "none",
                  borderBottom: active ? `2px solid ${APP.ink}` : "2px solid transparent",
                  padding: "6px 10px",
                  cursor: "pointer",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>

        {visible.length === 0 ? (
          <p style={{ color: APP.muted, fontSize: 15, marginTop: 32 }}>
            {filter === "unread"
              ? "You’re caught up — no unread hires."
              : "No one is marked Hired yet. Set Process → Hired on a candidate dossier."}
          </p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {visible.map((item) => (
              <HireRow
                key={item.candidateId}
                item={item}
                onOpen={() => openHire(item)}
                onToggleRead={() => setRead([item.candidateId], !item.read)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function HireRow({
  item,
  onOpen,
  onToggleRead,
}: {
  item: HireInboxItem;
  onOpen: () => void;
  onToggleRead: () => void;
}) {
  const subtitle = [item.currentTitle, item.company].filter(Boolean).join(" · ");

  return (
    <li
      style={{
        display: "grid",
        gridTemplateColumns: "18px 1fr auto",
        gap: 12,
        alignItems: "start",
        padding: "14px 4px",
        borderBottom: `1px solid ${APP.line}`,
      }}
    >
      <button
        type="button"
        aria-label={item.read ? "Mark unread" : "Mark read"}
        title={item.read ? "Mark unread" : "Mark read"}
        onClick={onToggleRead}
        style={{
          width: 18,
          height: 18,
          marginTop: 3,
          borderRadius: "50%",
          border: item.read ? `1.5px solid ${APP.hair}` : `2px solid ${APP.accent}`,
          background: item.read ? "transparent" : APP.accentSoft,
          cursor: "pointer",
          padding: 0,
          flexShrink: 0,
        }}
      />
      <button
        type="button"
        onClick={onOpen}
        style={{
          textAlign: "left",
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          fontFamily: APP.sans,
          color: APP.ink,
          minWidth: 0,
        }}
      >
        <div
          style={{
            fontSize: 16,
            fontWeight: item.read ? 500 : 700,
            letterSpacing: item.read ? 0 : "-0.01em",
          }}
        >
          {item.name}
        </div>
        <div style={{ fontSize: 13.5, color: APP.secondary, marginTop: 2 }}>
          {item.jobTitle}
          {subtitle ? (
            <span style={{ color: APP.faint }}>
              {" "}
              · {subtitle}
            </span>
          ) : null}
        </div>
      </button>
      <div
        style={{
          fontFamily: APP.mono,
          fontSize: 11.5,
          color: APP.muted,
          textAlign: "right",
          whiteSpace: "nowrap",
          paddingTop: 3,
        }}
        title={formatHiredAt(item.hiredAt)}
      >
        {relativeHired(item.hiredAt)}
      </div>
    </li>
  );
}
