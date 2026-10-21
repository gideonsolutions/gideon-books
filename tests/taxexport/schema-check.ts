/**
 * A small JSON Schema checker for the subset the export contract uses
 * (type, const, enum, pattern, required, properties, additionalProperties,
 * items, oneOf, $ref). Returns a list of problems.
 */
type Schema = Record<string, unknown>;

export function checkSchema(root: Schema, value: unknown): string[] {
  const problems: string[] = [];
  const resolve = (s: Schema): Schema => {
    const ref = s.$ref as string | undefined;
    if (!ref) return s;
    const path = ref.replace(/^#\//, "").split("/");
    let cur: unknown = root;
    for (const p of path) cur = (cur as Record<string, unknown>)[p];
    return resolve(cur as Schema);
  };
  const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
  const walk = (s0: Schema, v: unknown, at: string): boolean => {
    const s = resolve(s0);
    const before = problems.length;
    if (s.oneOf) {
      const ok = (s.oneOf as Schema[]).filter((alt) => {
        const sub: string[] = [];
        const saved = problems.splice(0);
        walk(alt, v, at);
        sub.push(...problems.splice(0));
        problems.push(...saved);
        return sub.length === 0;
      });
      if (ok.length !== 1) problems.push(`${at}: matches ${ok.length} of oneOf`);
      return problems.length === before;
    }
    if (s.const !== undefined && v !== s.const) problems.push(`${at}: expected ${JSON.stringify(s.const)}`);
    if (s.enum && !(s.enum as unknown[]).includes(v)) problems.push(`${at}: ${JSON.stringify(v)} not in enum`);
    if (s.type) {
      const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
      const t = typeOf(v);
      if (!types.includes(t) && !(t === "integer" && types.includes("number"))) problems.push(`${at}: type ${t}, expected ${types.join("|")}`);
    }
    if (typeof v === "string" && s.pattern && !new RegExp(s.pattern as string).test(v)) problems.push(`${at}: ${v} does not match ${s.pattern}`);
    if (typeof v === "string" && s.minLength !== undefined && v.length < (s.minLength as number)) problems.push(`${at}: too short`);
    if (typeof v === "number" && s.minimum !== undefined && v < (s.minimum as number)) problems.push(`${at}: below minimum`);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      for (const r of (s.required as string[]) ?? []) if (!(r in o)) problems.push(`${at}.${r}: required`);
      const props = (s.properties as Record<string, Schema>) ?? {};
      for (const [k, val] of Object.entries(o)) {
        if (props[k]) walk(props[k]!, val, `${at}.${k}`);
        else if (s.additionalProperties === false) problems.push(`${at}.${k}: not allowed`);
      }
    }
    if (Array.isArray(v) && s.items) v.forEach((item, i) => walk(s.items as Schema, item, `${at}[${i}]`));
    return problems.length === before;
  };
  walk(root, value, "$");
  return problems;
}
