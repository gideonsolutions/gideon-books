/**
 * Structured logs: one JSON object per line on stdout/stderr, with a level,
 * a message, a timestamp and context fields. Secret-looking fields are
 * redacted. LOG_LEVEL=debug|info|warn|error (default info).
 */
import { redact } from "@/lib/audit-redact";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const l = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
  return ORDER[l] ?? ORDER.info;
}

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (ORDER[level] < threshold()) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(fields ? (redact(fields) as Record<string, unknown>) : {}) });
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};
