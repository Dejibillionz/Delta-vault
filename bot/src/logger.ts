/**
 * Logger — Professional structured logging with clean formatting
 *
 * Verbosity levels:
 *   QUIET   - Only critical actions (trades, errors, APR)
 *   NORMAL  - Summary view each cycle + important events
 *   VERBOSE - Full details for debugging
 */

import * as fs from "fs";
import * as path from "path";

type Level = "INFO" | "TRADE" | "RISK" | "WARN" | "ERROR" | "DEBUG" | "SUMMARY";
type Verbosity = "QUIET" | "NORMAL" | "VERBOSE";

const COLORS: Record<Level, string> = {
  INFO:    "\x1b[36m",   // Cyan
  TRADE:   "\x1b[32m",   // Green (important)
  RISK:    "\x1b[31m",   // Red (critical)
  WARN:    "\x1b[33m",   // Yellow
  ERROR:   "\x1b[41m\x1b[37m", // Red background
  DEBUG:   "\x1b[90m",   // Gray
  SUMMARY: "\x1b[35m",   // Magenta
};

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

export class Logger {
  private logFile: fs.WriteStream | null = null;
  private verbosity: Verbosity = "NORMAL";
  private lastCycleNum = 0;

  constructor(logDir?: string, verbosity: Verbosity = "NORMAL") {
    this.verbosity = verbosity;

    if (logDir) {
      fs.mkdirSync(logDir, { recursive: true });
      const filename = `bot-${new Date().toISOString().slice(0, 10)}.log`;
      this.logFile = fs.createWriteStream(path.join(logDir, filename), { flags: "a" });
    }
  }

  private log(level: Level, msg: string, verbosityLevel: Verbosity = "NORMAL"): void {
    // Skip if below verbosity threshold
    const levels: Record<Verbosity, number> = { QUIET: 0, NORMAL: 1, VERBOSE: 2 };
    if (levels[verbosityLevel] > levels[this.verbosity]) return;

    const ts = new Date().toISOString();
    const shortTs = ts.slice(11, 19); // HH:MM:SS only
    const badge = `[${level.padEnd(6)}]`;
    const line = `${shortTs} ${badge} ${msg}`;

    console.log(`${COLORS[level]}${line}${RESET}`);
    this.logFile?.write(`${ts} ${badge} ${msg}\n`);
  }

  // ─── Core Methods ───────────────────────────────────────────────────────
  info(msg: string, verbose = false)     { this.log("INFO", msg, verbose ? "VERBOSE" : "NORMAL"); }
  trade(msg: string)                     { this.log("TRADE", msg); }
  risk(msg: string)                      { this.log("RISK", msg); }
  warn(msg: string)                      { this.log("WARN", msg); }
  error(msg: string)                     { this.log("ERROR", msg); }
  debug(msg: string)                     { this.log("DEBUG", msg, "VERBOSE"); }

  // ─── Formatted Output ────────────────────────────────────────────────────

  section(title: string) {
    const line = `${"─".repeat(72)}`;
    console.log(`\n${BOLD}${COLORS.INFO}${line}${RESET}`);
    console.log(`${BOLD}${COLORS.INFO} ${title}${RESET}`);
    console.log(`${BOLD}${COLORS.INFO}${line}${RESET}\n`);
    this.logFile?.write(`\n─── ${title} ───\n`);
  }

  cycleHeader(cycleNum: number) {
    if (this.verbosity === "QUIET") return;

    const header = `  CYCLE #${cycleNum}`;
    const line = "═".repeat(72);
    console.log(`\n${BOLD}${COLORS.SUMMARY}${line}${RESET}`);
    console.log(`${BOLD}${COLORS.SUMMARY}${header}${RESET}`);
    console.log(`${BOLD}${COLORS.SUMMARY}${line}${RESET}\n`);
    this.logFile?.write(`\n═══ CYCLE #${cycleNum} ═══\n`);
    this.lastCycleNum = cycleNum;
  }

  /** Print a data row: "Label: Value" */
  row(label: string, value: string) {
    const width = 28;
    const paddedLabel = label.padEnd(width);
    console.log(`  ${paddedLabel} ${value}`);
    this.logFile?.write(`  ${label.padEnd(width)} ${value}\n`);
  }

  /** Print a bullet point */
  bullet(text: string, indent = 2) {
    const spaces = " ".repeat(indent);
    console.log(`${spaces}• ${text}`);
    this.logFile?.write(`${spaces}• ${text}\n`);
  }

  /** Print a success bullet (✓) */
  success(text: string) {
    console.log(`  ${COLORS.TRADE}✓${RESET} ${text}`);
    this.logFile?.write(`  ✓ ${text}\n`);
  }

  /** Print an error bullet (✗) */
  failure(text: string) {
    console.log(`  ${COLORS.ERROR}✗${RESET} ${text}`);
    this.logFile?.write(`  ✗ ${text}\n`);
  }

  /** Print a table row: "[label] value | value | value" */
  tableRow(label: string, ...values: string[]) {
    const labelPart = label.padEnd(12);
    const valuePart = values.map(v => v.padEnd(14)).join(" | ");
    console.log(`  ${labelPart} │ ${valuePart}`);
    this.logFile?.write(`  ${label.padEnd(12)} │ ${valuePart}\n`);
  }

  /** Print summary stats (APR, PnL, etc.) */
  summary(stats: Record<string, string | number>) {
    console.log(`\n${BOLD}${COLORS.SUMMARY}[SUMMARY]${RESET}`);
    Object.entries(stats).forEach(([key, val]) => {
      const displayVal = typeof val === "number" ? val.toFixed(2) : val;
      this.row(key, displayVal);
    });
  }

  /** Divider line for section breaks */
  divider() {
    console.log(`  ${COLORS.INFO}${"─".repeat(68)}${RESET}`);
    this.logFile?.write(`  ${"─".repeat(68)}\n`);
  }

  close() { this.logFile?.end(); }
}
