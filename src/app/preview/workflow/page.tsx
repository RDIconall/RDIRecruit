"use client";

/**
 * Unauthenticated clickable mock: Workable-aligned triage table + stage kanban + deep dive.
 * Serves the static prototype at /mock/workable-pipeline.html inside the app shell so it
 * can be opened without Clerk when preview routes are public.
 */
export default function WorkflowMockPage() {
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <iframe
        title="Workable-aligned triage mock"
        src="/mock/workable-pipeline.html"
        style={{ border: 0, width: "100%", height: "100%" }}
      />
    </div>
  );
}
