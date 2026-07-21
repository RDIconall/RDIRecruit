"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { APP } from "@/lib/triage/app-theme";
import { inviteTeammate } from "@/app/actions/invites";

/**
 * Top-bar "Invite" affordance: a small popover with an email input. Sending
 * grants access (dynamic allowlist row) and emails a Clerk invitation, so the
 * invitee can sign up and get straight in.
 */
export function InviteButton() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const send = () => {
    const value = email.trim();
    if (!value || pending) return;
    setResult(null);
    startTransition(async () => {
      try {
        const res = await inviteTeammate({ email: value });
        setResult(res);
        if (res.ok) setEmail("");
      } catch {
        setResult({ ok: false, message: "Invite failed — please retry." });
      }
    });
  };

  return (
    <div ref={rootRef} style={{ position: "relative", flexShrink: 0 }}>
      <button
        onClick={() => {
          setOpen((v) => !v);
          setResult(null);
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        style={{
          fontFamily: APP.sans,
          fontSize: 13,
          color: APP.secondary,
          background: "transparent",
          border: `1px solid ${APP.hair}`,
          borderRadius: 6,
          padding: "5px 12px",
          cursor: "pointer",
        }}
        title="Invite a teammate — they get an email and immediate access"
      >
        Invite
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Invite a teammate"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            width: 320,
            background: APP.surface,
            border: `1px solid ${APP.hair}`,
            borderRadius: 8,
            boxShadow: "0 8px 28px rgba(0,0,0,0.10)",
            padding: 14,
            zIndex: 50,
          }}
        >
          <div style={{ fontSize: 13.5, fontWeight: 600, color: APP.ink, marginBottom: 8 }}>
            Invite a teammate
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") send();
              }}
              placeholder="name@rditrials.com"
              autoFocus
              style={{
                flex: 1,
                fontFamily: APP.sans,
                fontSize: 13.5,
                color: APP.ink,
                border: `1px solid ${APP.hair}`,
                borderRadius: 6,
                padding: "7px 10px",
                outline: "none",
              }}
            />
            <button
              onClick={send}
              disabled={pending || !email.trim()}
              style={{
                fontFamily: APP.sans,
                fontSize: 13,
                fontWeight: 600,
                color: "#FFFFFF",
                background: pending || !email.trim() ? APP.muted : APP.accent,
                border: "none",
                borderRadius: 6,
                padding: "7px 14px",
                cursor: pending || !email.trim() ? "default" : "pointer",
              }}
            >
              {pending ? "Sending…" : "Send"}
            </button>
          </div>
          <div style={{ fontSize: 12, color: APP.muted, marginTop: 8, lineHeight: 1.45 }}>
            They get a sign-up email and access as soon as they log in.
          </div>
          {result && (
            <div
              style={{
                fontFamily: APP.mono,
                fontSize: 12,
                color: result.ok ? APP.accent : APP.weak,
                marginTop: 8,
                lineHeight: 1.45,
              }}
            >
              {result.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
