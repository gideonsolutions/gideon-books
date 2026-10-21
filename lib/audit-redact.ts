/** Redaction of secret-looking values before they are logged or audited. */

const SECRET_KEY_RE = /(password|secret|token|api[_-]?key|access[_-]?url|authorization|private|signing|totp|ssn|tax_?id|account_?number|routing)/i;

/** Deep-copy `value` with secret-looking fields replaced by "[redacted]". */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k) && v !== null && v !== undefined && v !== "") out[k] = "[redacted]";
      else out[k] = redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 4000) return value.slice(0, 4000) + "…";
  return value;
}
