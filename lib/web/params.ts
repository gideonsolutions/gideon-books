/** Reading search params from a page's props. */
export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function readParams(sp: SearchParams): Promise<Record<string, string | undefined>> {
  const raw = await sp;
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = Array.isArray(v) ? v[0] : v;
  return out;
}

export function intParam(v: string | undefined, fallback: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function dateParam(v: string | undefined): string | undefined {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
}
