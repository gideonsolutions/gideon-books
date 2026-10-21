/**
 * What the database holds for one organization, discovered from the
 * catalog rather than listed by hand, so data export, import and deletion
 * keep working as modules add tables: every table with an `org_id` column,
 * plus child tables that hang off one of them without their own `org_id`
 * (email events under email messages). Tables are ordered so that a row's
 * foreign-key parents come first.
 */
import type pg from "pg";

export interface ColumnInfo {
  name: string;
  udt: string;
  isSerial: boolean;
  nullable: boolean;
}

export interface ForeignKey {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  /** The org_id column, or how the table reaches its organization through a parent. */
  scope: { kind: "org_id" } | { kind: "child"; column: string; parentTable: string; parentColumn: string };
  foreignKeys: ForeignKey[];
  /** Foreign keys to rows of the same table (parents must be inserted first). */
  selfKeys: ForeignKey[];
  /** Columns that close a cycle between tables: inserted null, filled in afterwards. */
  deferredColumns: string[];
  primaryKey: string[];
}

type Queryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

export async function describeOrgTables(db: Queryable): Promise<TableInfo[]> {
  const cols = await db.query<{ table_name: string; column_name: string; udt_name: string; column_default: string | null; is_nullable: string }>(
    `select c.table_name, c.column_name, c.udt_name, c.column_default, c.is_nullable
       from information_schema.columns c
       join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.table_schema = 'public'
      order by c.table_name, c.ordinal_position`,
  );
  const fks = await db.query<{ conname: string; tbl: string; ref_tbl: string; cols: string[]; ref_cols: string[] }>(
    `select c.conname, t.relname as tbl, ft.relname as ref_tbl,
            (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as cols,
            (select array_agg(a.attname::text order by k.ord) from unnest(c.confkey) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) as ref_cols
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid
       join pg_class ft on ft.oid = c.confrelid
       join pg_namespace n on n.oid = t.relnamespace
      where c.contype = 'f' and n.nspname = 'public'`,
  );
  const pks = await db.query<{ tbl: string; cols: string[] }>(
    `select t.relname as tbl,
            (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as cols
       from pg_constraint c join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace
      where c.contype = 'p' and n.nspname = 'public'`,
  );
  const byTable = new Map<string, ColumnInfo[]>();
  for (const c of cols.rows) {
    const list = byTable.get(c.table_name) ?? [];
    list.push({ name: c.column_name, udt: c.udt_name, isSerial: !!c.column_default?.startsWith("nextval("), nullable: c.is_nullable === "YES" });
    byTable.set(c.table_name, list);
  }
  const pg_arr = (v: string[] | string): string[] => (Array.isArray(v) ? v : String(v).replace(/^{|}$/g, "").split(","));
  const fkByTable = new Map<string, ForeignKey[]>();
  for (const f of fks.rows) {
    const list = fkByTable.get(f.tbl) ?? [];
    list.push({ name: f.conname, columns: pg_arr(f.cols), refTable: f.ref_tbl, refColumns: pg_arr(f.ref_cols) });
    fkByTable.set(f.tbl, list);
  }
  const pkByTable = new Map(pks.rows.map((p) => [p.tbl, pg_arr(p.cols)]));

  const scoped = new Map<string, TableInfo>();
  for (const [name, columns] of byTable) {
    if (name === "organizations" || name.startsWith("__")) continue;
    if (columns.some((c) => c.name === "org_id")) {
      scoped.set(name, { name, columns, scope: { kind: "org_id" }, foreignKeys: fkByTable.get(name) ?? [], selfKeys: [], deferredColumns: [], primaryKey: pkByTable.get(name) ?? [] });
    }
  }
  // Child tables: no org_id, but a single-column foreign key to a scoped table's id.
  for (const [name, columns] of byTable) {
    if (scoped.has(name) || name === "organizations") continue;
    const fk = (fkByTable.get(name) ?? []).find((f) => f.columns.length === 1 && scoped.has(f.refTable) && f.refColumns[0] === "id");
    if (fk) {
      scoped.set(name, {
        name,
        columns,
        scope: { kind: "child", column: fk.columns[0]!, parentTable: fk.refTable, parentColumn: "id" },
        foreignKeys: fkByTable.get(name) ?? [],
        selfKeys: [],
        deferredColumns: [],
        primaryKey: pkByTable.get(name) ?? [],
      });
    }
  }
  for (const t of scoped.values()) {
    t.selfKeys = t.foreignKeys.filter((f) => f.refTable === t.name);
  }
  return topoSort([...scoped.values()]);
}

/** Order tables parents-first. Edges that would close a cycle are deferred. */
function topoSort(tables: TableInfo[]): TableInfo[] {
  const names = new Set(tables.map((t) => t.name));
  const deps = new Map<string, Set<string>>();
  for (const t of tables) {
    deps.set(t.name, new Set(t.foreignKeys.filter((f) => f.refTable !== t.name && names.has(f.refTable)).map((f) => f.refTable)));
  }
  const out: TableInfo[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const byName = new Map(tables.map((t) => [t.name, t]));
  const visit = (n: string) => {
    if (done.has(n)) return;
    visiting.add(n);
    const t = byName.get(n)!;
    for (const d of [...(deps.get(n) ?? [])].sort()) {
      if (visiting.has(d)) {
        // A cycle: this table's columns pointing at `d` are inserted null and filled in later.
        for (const f of t.foreignKeys.filter((f) => f.refTable === d)) {
          for (const c of f.columns) if (c !== "org_id" && !t.deferredColumns.includes(c)) t.deferredColumns.push(c);
        }
        continue;
      }
      visit(d);
    }
    visiting.delete(n);
    done.add(n);
    out.push(t);
  };
  for (const n of [...names].sort()) visit(n);
  return out;
}

/** Order rows so a row referenced by another row of the same table comes first. */
export function orderSelfReferencing(t: TableInfo, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  if (!t.selfKeys.length || !t.columns.some((c) => c.name === "id")) return rows;
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const out: Record<string, unknown>[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (r: Record<string, unknown>) => {
    const id = String(r.id);
    if (done.has(id) || visiting.has(id)) return;
    visiting.add(id);
    for (const f of t.selfKeys) {
      const col = f.columns.find((c) => c !== "org_id");
      const ref = col ? r[col] : null;
      if (ref && byId.has(String(ref))) visit(byId.get(String(ref))!);
    }
    visiting.delete(id);
    done.add(id);
    out.push(r);
  };
  for (const r of rows) visit(r);
  return out;
}

/** A stable ORDER BY for exporting a table (serial order first, then the primary key). */
export function orderByFor(t: TableInfo): string {
  const serial = t.columns.find((c) => c.isSerial);
  if (serial) return `"${serial.name}"`;
  if (t.name === "journal_entries") return `entry_number nulls last, created_at, id`;
  const created = t.columns.find((c) => c.name === "created_at");
  const keys = t.primaryKey.length ? t.primaryKey.map((k) => `"${k}"`) : t.columns.map((c) => `"${c.name}"`).slice(0, 3);
  return [created ? `"created_at"` : null, ...keys].filter(Boolean).join(", ");
}
