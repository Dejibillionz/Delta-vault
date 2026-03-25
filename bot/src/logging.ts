// ── Logging Utilities ────────────────────────────────────────────────────────
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

export function debugLog(msg: string) {
  if (LOG_LEVEL === "debug") {
    console.log(msg);
  }
}

export enum LogLevel {
  INFO,
  WARN,
  ERROR,
}