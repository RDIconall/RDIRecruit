"use client";

import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import {
  type ColumnDef,
  type FilterFn,
  type Header,
  type PaginationState,
  type Row,
  type RowData,
  type RowSelectionState,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  APP,
  DECISION_LABEL,
  POOL_GROUPS,
  poolGroupOf,
  fitWeight,
  valueWeight,
} from "@/lib/triage/app-theme";
import type { Candidate, Decision } from "@/lib/triage/types";
import {
  Avatar,
  Checkbox,
  Dot,
  DisqButton,
  StandingLine,
  StatusSelect,
  ValueCell,
  compactAsk,
  ellipsis,
  mono,
} from "./pool-shared";

// Per-column layout hints. TanStack's ColumnMeta is intentionally empty so the
// product can attach whatever it needs; we use it to drive width + alignment of
// the accessible <th>/<td> cells without leaking layout into the column logic.
declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    width?: number;
    align?: "left" | "right" | "center";
    mono?: boolean;
    label?: string; // accessible header text when the rendered header is non-textual
    noTruncate?: boolean; // cells size to content (no overflow clipping) — e.g. action buttons
  }
}

const PAGE_SIZES = [25, 50, 100] as const;
const ALL_ROWS = 100_000; // "All" page size sentinel — larger than any real pool

const SELECT_W = 36;

type Density = "comfortable" | "compact";
const ROW_PAD_Y: Record<Density, number> = { comfortable: 6, compact: 2 };
const AVATAR_SIZE: Record<Density, number> = { comfortable: 26, compact: 20 };

// Decision filter selector options (Coyle: "basic filter selectors").
const GROUP_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All groups" },
  ...POOL_GROUPS.map((g) => ({ value: g.key, label: DECISION_LABEL[g.key] })),
];

const DESKTOP_COLUMNS: VisibilityState = {};
const MID_COLUMNS: VisibilityState = { company: false, answers: false, ro: false };
const NARROW_COLUMNS: VisibilityState = { company: false, answers: false, spec: false, ro: false };

/** Leading integer of an experience string ("16 yr" → 16, "—" → -1) for sorting. */
function expNum(s: string): number {
  const m = s.match(/\d+/);
  return m ? parseInt(m[0], 10) : -1;
}

function daysSinceApplied(appliedAt: string | null): number | null {
  if (!appliedAt) return null;
  const ms = Date.now() - new Date(appliedAt).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, ms / 86_400_000);
}

function appliedSortValue(appliedAt: string | null): number {
  return daysSinceApplied(appliedAt) ?? Number.POSITIVE_INFINITY;
}

const globalFilterFn: FilterFn<Candidate> = (row, _columnId, value) => {
  const q = String(value ?? "").toLowerCase().trim();
  if (!q) return true;
  const c = row.original;
  return [c.name, c.company, c.role, c.locationShort, c.roLevel]
    .filter(Boolean)
    .some((s) => s.toLowerCase().includes(q));
};

interface PoolTableProps {
  /** Active (non-disqualified) candidates, pre-ordered by pool standing. */
  active: Candidate[];
  /** Controlled row selection, shared with the board's bulk-action bar (keyed by candidate id). */
  rowSelection: RowSelectionState;
  onRowSelectionChange: React.Dispatch<React.SetStateAction<RowSelectionState>>;
  openCandidate: (id: string) => void;
  onDisqualify: (id: string) => void;
  onSetDecision: (id: string, d: Decision) => void;
  /**
   * When true (default) sorting / search / pagination are mirrored to the URL via
   * history.replaceState (no navigation, no server refetch) so the view is
   * shareable and survives reload. Set false to keep state purely product-owned.
   */
  syncUrl?: boolean;
}

export function PoolTable({
  active,
  rowSelection,
  onRowSelectionChange,
  openCandidate,
  onDisqualify,
  onSetDecision,
  syncUrl = true,
}: PoolTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(DESKTOP_COLUMNS);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: ALL_ROWS });
  const [menuOpen, setMenuOpen] = useState(false);
  const [density, setDensity] = useState<Density>("compact");
  const [groupFilter, setGroupFilter] = useState<string>("all");

  // Decision-group filter (Coyle: "basic filter selectors") — narrows the rows
  // to one decision group before the table sees them, so search/sort/selection
  // all operate on the focused set.
  const data = useMemo(
    () => (groupFilter === "all" ? active : active.filter((c) => poolGroupOf(c.decision) === groupFilter)),
    [active, groupFilter],
  );

  // --- URL <-> state sync (opt-in). Read once on mount to avoid hydration drift,
  // then write back on change. history.replaceState keeps it client-side. -------
  const mounted = useRef(false);
  useEffect(() => {
    if (!syncUrl || typeof window === "undefined") return;
    const p = new URLSearchParams(window.location.search);
    const q = p.get("q");
    if (q) setGlobalFilter(q);
    const sort = p.get("sort");
    if (sort) {
      const [id, dir] = sort.split(":");
      if (id) setSorting([{ id, desc: dir === "desc" }]);
    }
    const ps = p.get("ps");
    if (ps) setPagination((s) => ({ ...s, pageSize: ps === "all" ? ALL_ROWS : Number(ps) || s.pageSize }));
    mounted.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncUrl]);

  useEffect(() => {
    if (!syncUrl || !mounted.current || typeof window === "undefined") return;
    const p = new URLSearchParams(window.location.search);
    if (globalFilter) p.set("q", globalFilter);
    else p.delete("q");
    if (sorting[0]) p.set("sort", `${sorting[0].id}:${sorting[0].desc ? "desc" : "asc"}`);
    else p.delete("sort");
    if (pagination.pageSize >= ALL_ROWS) p.set("ps", "all");
    else p.set("ps", String(pagination.pageSize));
    const qs = p.toString();
    window.history.replaceState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
  }, [syncUrl, globalFilter, sorting, pagination]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const applyResponsiveColumns = () => {
      if (window.innerWidth < 1100) setColumnVisibility(NARROW_COLUMNS);
      else if (window.innerWidth < 1280) setColumnVisibility(MID_COLUMNS);
      else setColumnVisibility(DESKTOP_COLUMNS);
    };
    applyResponsiveColumns();
    window.addEventListener("resize", applyResponsiveColumns);
    return () => window.removeEventListener("resize", applyResponsiveColumns);
  }, []);

  const columns = useMemo<ColumnDef<Candidate>[]>(
    () => [
      {
        id: "select",
        enableSorting: false,
        enableHiding: false,
        meta: { width: SELECT_W, align: "center" },
        header: ({ table }) => (
          <Checkbox
            checked={table.getIsAllRowsSelected()}
            indeterminate={table.getIsSomeRowsSelected()}
            onChange={() => table.toggleAllRowsSelected()}
            label="Select all candidates"
          />
        ),
        cell: ({ row }) => (
          <Checkbox checked={row.getIsSelected()} onChange={() => row.toggleSelected()} label={`Select ${row.original.name}`} />
        ),
      },
      {
        id: "candidate",
        accessorFn: (c) => c.name,
        header: "Candidate",
        sortingFn: "textCaseSensitive",
        meta: { label: "Candidate", width: 236 },
        cell: ({ row }) => <CandidateCell c={row.original} density={density} onOpen={() => openCandidate(row.original.id)} />,
      },
      {
        id: "applied",
        accessorFn: (c) => appliedSortValue(c.appliedAt),
        header: "Applied",
        meta: { width: 62, align: "right", mono: true },
        cell: ({ row }) => <AppliedCell appliedAt={row.original.appliedAt} />,
      },
      {
        id: "company",
        accessorFn: (c) => c.company,
        header: "Company",
        meta: { width: 140 },
        cell: ({ row }) => (
          <span style={{ fontSize: 13.5, color: APP.ink2, display: "block", ...ellipsis }} title={row.original.company}>
            {row.original.company}
          </span>
        ),
      },
      {
        id: "location",
        accessorFn: (c) => c.locationShort,
        header: "Location",
        meta: { width: 122 },
        cell: ({ row }) => (
          <span style={{ fontSize: 13, color: APP.secondary, display: "block", ...ellipsis }} title={row.original.locationShort}>
            {row.original.locationShort}
          </span>
        ),
      },
      {
        id: "experience",
        accessorFn: (c) => expNum(c.experience),
        header: "Exp.",
        sortDescFirst: true,
        meta: { width: 54, align: "right", mono: true },
        cell: ({ row }) => row.original.experience,
      },
      {
        id: "ask",
        accessorFn: (c) => c.salaryNum,
        header: "Ask",
        sortDescFirst: true,
        meta: { width: 74, align: "right", mono: true },
        cell: ({ row }) => (
          <span title={row.original.salary} style={{ fontVariantNumeric: "tabular-nums" }}>
            {compactAsk(row.original.salary)}
          </span>
        ),
      },
      {
        id: "value",
        accessorFn: (c) => valueWeight(c.value?.level ?? "none"),
        header: "Value",
        sortDescFirst: true,
        meta: { label: "Value", width: 88 },
        cell: ({ row }) => <ValueCell value={row.original.value} />,
      },
      {
        id: "answers",
        accessorFn: (c) => fitWeight(c.answersRead.level),
        header: "Answers",
        sortDescFirst: true,
        meta: { width: 92 },
        cell: ({ row }) => <Dot read={row.original.answersRead} />,
      },
      {
        id: "spec",
        accessorFn: (c) => fitWeight(c.specRead.level),
        header: "Vs. spec",
        sortDescFirst: true,
        meta: { width: 92 },
        cell: ({ row }) => <Dot read={row.original.specRead} />,
      },
      {
        id: "ro",
        accessorFn: (c) => c.roLevel,
        header: "Level",
        meta: { width: 54, align: "right", mono: true },
        cell: ({ row }) => (
          <span title={row.original.roLevel} style={{ ...ellipsis, display: "block" }}>
            {row.original.roLevel}
          </span>
        ),
      },
      {
        id: "actions",
        enableSorting: false,
        enableHiding: false,
        header: "Actions",
        meta: { width: 224, align: "right", noTruncate: true },
        cell: ({ row }) => (
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8 }}>
            <StatusSelect value={row.original.decision} onChange={(d) => onSetDecision(row.original.id, d)} />
            <a
              href={row.original.workableUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title="Open in Workable"
              aria-label={`Open ${row.original.name} in Workable`}
              style={mono({ fontSize: 13, color: APP.muted, textDecoration: "none", whiteSpace: "nowrap", padding: "0 2px" })}
            >
              ↗
            </a>
            <DisqButton onClick={() => onDisqualify(row.original.id)} />
          </div>
        ),
      },
    ],
    [openCandidate, onDisqualify, onSetDecision, density],
  );

  const table = useReactTable({
    data,
    columns,
    state: { sorting, rowSelection, columnVisibility, globalFilter, pagination },
    getRowId: (c) => c.id,
    enableRowSelection: true,
    globalFilterFn,
    onSortingChange: setSorting,
    onRowSelectionChange,
    onColumnVisibilityChange: setColumnVisibility,
    onGlobalFilterChange: setGlobalFilter,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  const visibleLeaf = table.getVisibleLeafColumns();
  // Drive the layout off proportional weights, not fixed pixels: every column
  // (incl. Candidate) gets a share of the table width, so widening the viewport
  // scales the whole grid together instead of dumping all the slack into one
  // ballooning column. minWidth = the weight sum, so below it the grid scrolls.
  const totalWidth = visibleLeaf.reduce((sum, col) => sum + (col.columnDef.meta?.width ?? 0), 0);
  const rows = table.getRowModel().rows;
  // Bucket the (sorted / filtered / paginated) rows into the fixed decision groups
  // so the board keeps its "Interview → Backup → Reject → Blocked" priority reading
  // while every group respects whatever sort the recruiter applied.
  const grouped = useMemo(() => {
    const map = new Map<Decision, Row<Candidate>[]>();
    for (const r of rows) {
      const g = poolGroupOf(r.original.decision);
      const list = map.get(g);
      if (list) list.push(r);
      else map.set(g, [r]);
    }
    return POOL_GROUPS.map((g) => ({ ...g, rows: map.get(g.key) ?? [] })).filter((g) => g.rows.length > 0);
  }, [rows]);

  const totalRows = table.getFilteredRowModel().rows.length;
  const paged = pagination.pageSize < ALL_ROWS && totalRows > pagination.pageSize;

  return (
    <div>
      {/* toolbar: search + decision filter + density + column visibility */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: "1 1 240px", maxWidth: 340 }}>
          <input
            type="search"
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            placeholder="Search name, company, location…"
            aria-label="Search candidates"
            style={{
              width: "100%",
              boxSizing: "border-box",
              border: `1px solid ${APP.hair}`,
              borderRadius: 7,
              padding: "8px 12px",
              fontSize: 13.5,
              fontFamily: APP.sans,
              color: APP.ink,
              outline: "none",
            }}
          />
        </div>
        <select
          value={groupFilter}
          onChange={(e) => setGroupFilter(e.target.value)}
          aria-label="Filter by decision group"
          style={mono({ fontSize: 12, color: APP.ink, background: APP.surface, border: `1px solid ${APP.hair}`, borderRadius: 6, padding: "7px 8px", cursor: "pointer" })}
        >
          {GROUP_FILTERS.map((g) => (
            <option key={g.value} value={g.value}>
              {g.label}
            </option>
          ))}
        </select>
        <span style={{ flex: 1 }} />
        <DensityToggle density={density} setDensity={setDensity} />
        <ColumnMenu table={table} open={menuOpen} setOpen={setMenuOpen} />
      </div>

      {/* The default responsive column sets are sized to fit the viewport. If a
          user manually reveals more columns than fit, this wrapper provides a
          normal horizontal scroll without overlaying sticky cells. */}
      <div style={{ overflowX: "auto", overflowY: "visible" }}>
        <table
          style={{ width: "100%", minWidth: totalWidth, borderCollapse: "separate", borderSpacing: 0, tableLayout: "fixed", fontFamily: APP.sans }}
        >
          <caption style={srOnly}>
            Candidate triage pool, grouped by decision in priority order. Use the column headers to sort.
          </caption>
          {/* Explicit colgroup drives the fixed layout so header and body columns
              always line up — and stay correct when columns are hidden. Widths are
              percentages of the weight sum, so the columns keep their proportions
              at any table width. */}
          <colgroup>
            {visibleLeaf.map((col) => {
              const w = col.columnDef.meta?.width ?? 0;
              return <col key={col.id} style={{ width: totalWidth ? `${(w / totalWidth) * 100}%` : undefined }} />;
            })}
          </colgroup>
          <thead>
            <tr>
              {table.getHeaderGroups()[0].headers.map((header) => (
                <Th key={header.id} header={header} />
              ))}
            </tr>
          </thead>
          {grouped.map((g) => (
            <tbody key={g.key}>
              <tr>
                <th
                  scope="colgroup"
                  colSpan={visibleLeaf.length}
                  style={mono({
                    textAlign: "left",
                    padding: "10px 8px 5px",
                    fontSize: 10.5,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    color: APP.faint,
                    fontWeight: 400,
                    borderBottom: `1px solid ${APP.hair2}`,
                  })}
                >
                  <span style={{ color: APP.ink, fontWeight: 600 }}>{g.label}</span> <span>{g.rows.length}</span>
                </th>
              </tr>
              {g.rows.map((row) => (
                <DataRow key={row.id} row={row} density={density} onOpen={() => openCandidate(row.original.id)} />
              ))}
            </tbody>
          ))}
        </table>
      </div>

      {totalRows === 0 && (
        <div style={mono({ padding: "28px 8px", fontSize: 12.5, color: APP.muted })}>
          No candidates match “{globalFilter}”.
        </div>
      )}

      <Pagination table={table} paged={paged} totalRows={totalRows} pageSize={pagination.pageSize} />
    </div>
  );
}

const srOnly: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

function Th({ header }: { header: Header<Candidate, unknown> }) {
  const { column } = header;
  const meta = column.columnDef.meta;
  const canSort = column.getCanSort();
  const sorted = column.getIsSorted(); // false | "asc" | "desc"
  const ariaSort = sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : canSort ? "none" : undefined;
  const align = meta?.align ?? "left";
  const label = flexRender(column.columnDef.header, header.getContext());

  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      style={mono({
        textAlign: align,
        verticalAlign: "bottom",
        padding: "0 8px 7px",
        background: APP.surface,
        borderBottom: `1px solid ${APP.ink}`,
        fontSize: 10.5,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        fontWeight: 400,
        color: APP.faint,
      })}
    >
      {canSort ? (
        <button
          type="button"
          onClick={column.getToggleSortingHandler()}
          title={sorted ? `Sorted ${sorted === "asc" ? "ascending" : "descending"} — click to change` : "Sort by this column"}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            flexDirection: align === "right" ? "row-reverse" : "row",
            background: "transparent",
            border: "none",
            padding: 0,
            margin: 0,
            font: "inherit",
            letterSpacing: "inherit",
            textTransform: "inherit",
            color: sorted ? APP.ink : APP.faint,
            cursor: "pointer",
          }}
        >
          <span style={ellipsis}>{label}</span>
          <span aria-hidden style={{ fontSize: 9, opacity: sorted ? 1 : 0.45 }}>
            {sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : "↕"}
          </span>
        </button>
      ) : (
        <span style={{ display: "block", textAlign: align, ...ellipsis }}>{label}</span>
      )}
    </th>
  );
}

function AppliedCell({ appliedAt }: { appliedAt: string | null }) {
  const days = daysSinceApplied(appliedAt);
  if (days == null) return <span style={{ color: APP.faint }}>—</span>;

  const isNew = days < 1;
  const label = isNew ? "New" : `${Math.floor(days)}d`;
  const appliedDate = new Date(appliedAt!);
  const title = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(appliedDate);

  return (
    <span
      title={`Applied ${title}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: isNew ? 34 : undefined,
        color: isNew ? "#166534" : APP.secondary,
        background: isNew ? "#DCFCE7" : "transparent",
        border: isNew ? "1px solid #BBF7D0" : "none",
        borderRadius: 999,
        padding: isNew ? "1px 6px" : 0,
        fontWeight: isNew ? 700 : 500,
      }}
    >
      {label}
    </span>
  );
}

function DataRow({ row, density, onOpen }: { row: Row<Candidate>; density: Density; onOpen: () => void }) {
  const [hover, setHover] = useState(false);
  const selected = row.getIsSelected();
  // Frozen cells paint over the columns scrolling beneath them, so they need an
  // opaque background that mirrors the row state (selected / hover / base).
  const rowBg = selected ? APP.accentSoft : hover ? APP.rowHover : APP.surface;
  const padY = ROW_PAD_Y[density];
  return (
    <tr
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ cursor: "pointer", background: rowBg }}
    >
      {row.getVisibleCells().map((cell) => {
        const meta = cell.column.columnDef.meta;
        const isRowHeader = cell.column.id === "candidate";
        const content = flexRender(cell.column.columnDef.cell, cell.getContext());
        const style: CSSProperties = {
          padding: `${padY}px 8px`,
          verticalAlign: "middle",
          overflow: meta?.noTruncate ? "visible" : "hidden",
          whiteSpace: meta?.noTruncate ? "nowrap" : undefined,
          textAlign: meta?.align ?? "left",
          fontSize: 13,
          color: APP.ink2,
          // Row border lives on the cells (border-collapse: separate ignores <tr> borders).
          borderBottom: `1px solid ${APP.line}`,
          ...(cell.column.id === "candidate" ? { borderRight: `1px solid ${APP.hair}` } : null),
          ...(meta?.mono ? { fontFamily: APP.mono, fontVariantNumeric: "tabular-nums" } : null),
        };
        if (isRowHeader) {
          return (
            <th key={cell.id} scope="row" style={{ ...style, fontWeight: 400 }}>
              {content}
            </th>
          );
        }
        return (
          <td key={cell.id} style={style}>
            {content}
          </td>
        );
      })}
    </tr>
  );
}

function DensityToggle({ density, setDensity }: { density: Density; setDensity: (d: Density) => void }) {
  const opt = (value: Density, label: string) => {
    const on = density === value;
    return (
      <button
        type="button"
        onClick={() => setDensity(value)}
        aria-pressed={on}
        title={`${label} row height`}
        style={mono({
          cursor: "pointer",
          background: on ? APP.ink : "transparent",
          color: on ? "#fff" : APP.secondary,
          border: "none",
          borderRadius: 5,
          padding: "5px 10px",
          fontSize: 11.5,
        })}
      >
        {label}
      </button>
    );
  };
  return (
    <div role="group" aria-label="Row density" style={{ display: "inline-flex", gap: 2, border: `1px solid ${APP.hair}`, borderRadius: 7, padding: 2 }}>
      {opt("comfortable", "Comfortable")}
      {opt("compact", "Compact")}
    </div>
  );
}

function CandidateCell({ c, density, onOpen }: { c: Candidate; density: Density; onOpen: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
      <Avatar c={c} size={AVATAR_SIZE[density]} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          style={{
            display: "block",
            maxWidth: "100%",
            textAlign: "left",
            background: "transparent",
            border: "none",
            padding: 0,
            margin: 0,
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: 13.5,
            fontWeight: 600,
            lineHeight: 1.2,
            color: APP.ink,
            ...ellipsis,
          }}
          title={c.name}
        >
          {c.decision === "interview" && c.standing?.groupRank ? (
            <span style={mono({ color: APP.accent, marginRight: 6, fontSize: 12.5 })}>#{c.standing.groupRank}</span>
          ) : null}
          {c.name}
        </button>
        <div style={{ fontSize: 11, color: APP.muted, lineHeight: 1.15, ...ellipsis }} title={c.role}>
          {c.role}
        </div>
        <StandingLine c={c} />
      </div>
    </div>
  );
}

function ColumnMenu({
  table,
  open,
  setOpen,
}: {
  table: ReturnType<typeof useReactTable<Candidate>>;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, setOpen]);

  const hideable = table.getAllLeafColumns().filter((c) => c.getCanHide());

  return (
    <div style={{ position: "relative" }} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="true"
        aria-expanded={open}
        style={mono({
          cursor: "pointer",
          background: open ? APP.ink : "transparent",
          color: open ? "#fff" : APP.secondary,
          border: `1px solid ${open ? APP.ink : APP.hair}`,
          borderRadius: 6,
          padding: "7px 12px",
          fontSize: 12,
        })}
      >
        Columns ⌄
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 6px)",
            zIndex: 30,
            minWidth: 190,
            background: APP.surface,
            border: `1px solid ${APP.hair}`,
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.10)",
            padding: 6,
          }}
        >
          {hideable.map((column) => {
            const meta = column.columnDef.meta;
            const text = meta?.label ?? (typeof column.columnDef.header === "string" ? column.columnDef.header : column.id);
            return (
              <label
                key={column.id}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", fontSize: 13, color: APP.ink, cursor: "pointer", borderRadius: 5 }}
              >
                <input
                  type="checkbox"
                  checked={column.getIsVisible()}
                  onChange={column.getToggleVisibilityHandler()}
                  style={{ accentColor: APP.accent, cursor: "pointer" }}
                />
                {text}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Pagination({
  table,
  paged,
  totalRows,
  pageSize,
}: {
  table: ReturnType<typeof useReactTable<Candidate>>;
  paged: boolean;
  totalRows: number;
  pageSize: number;
}) {
  const { pageIndex } = table.getState().pagination;
  const start = totalRows === 0 ? 0 : pageIndex * pageSize + 1;
  const end = Math.min(totalRows, (pageIndex + 1) * pageSize);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 14, flexWrap: "wrap" }}>
      <div style={mono({ fontSize: 11.5, color: APP.muted })}>
        {paged ? `${start}–${end} of ${totalRows}` : `${totalRows} candidate${totalRows === 1 ? "" : "s"}`}
      </div>
      <span style={{ flex: 1 }} />
      <label style={mono({ fontSize: 11.5, color: APP.muted, display: "flex", alignItems: "center", gap: 6 })}>
        Rows
        <select
          value={pageSize >= ALL_ROWS ? "all" : String(pageSize)}
          onChange={(e) => table.setPageSize(e.target.value === "all" ? ALL_ROWS : Number(e.target.value))}
          aria-label="Rows per page"
          style={mono({ fontSize: 11.5, color: APP.ink, background: APP.surface, border: `1px solid ${APP.hair}`, borderRadius: 4, padding: "3px 6px", cursor: "pointer" })}
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
          <option value="all">All</option>
        </select>
      </label>
      {paged && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <PagerButton onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
            ← Prev
          </PagerButton>
          <span style={mono({ fontSize: 11.5, color: APP.secondary })}>
            {pageIndex + 1} / {table.getPageCount()}
          </span>
          <PagerButton onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
            Next →
          </PagerButton>
        </div>
      )}
    </div>
  );
}

function PagerButton({ onClick, disabled, children }: { onClick: () => void; disabled: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={mono({
        cursor: disabled ? "default" : "pointer",
        background: "transparent",
        color: disabled ? "#CFCFCF" : APP.secondary,
        border: `1px solid ${disabled ? APP.line : APP.hair}`,
        borderRadius: 5,
        padding: "5px 11px",
        fontSize: 12,
      })}
    >
      {children}
    </button>
  );
}
