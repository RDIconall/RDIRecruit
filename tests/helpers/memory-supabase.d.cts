export interface MemoryRow {
  [column: string]: unknown;
}

export interface MemorySupabase {
  reset(): void;
  rows(table: string): MemoryRow[];
  upserts: Array<{ table: string; row: MemoryRow }>;
  from(table: string): unknown;
  rpc(name: string, args?: Record<string, unknown>): Promise<{
    data: unknown;
    error: { message: string } | null;
  }>;
}

export const memorySupabase: MemorySupabase;
