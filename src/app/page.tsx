import { TriageApp } from "@/components/triage/triage-app";

// Pool + candidate triage live in one client surface (view-switched, like the
// reference prototype). Auth is enforced by Clerk middleware. Prototype state
// persists to localStorage (rdi-recruit-ws-v1); wire to the DB server-side.
export default function HomePage() {
  return <TriageApp />;
}
