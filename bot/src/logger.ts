/**
 * Logger — structured console output with severity levels and file rotation
 */

import * as fs from "fs";
import * as path from "path";

type Level = "INFO" | "TRADE" | "RISK" | "WARN" | "ERROR" | "DEBUG";

const COLORS: Record<Level, string> = {
  INFO:  "\x1b[36m",   // cyan
  TRADE: "\x1b[32m",   // green
  RISK:  "\x1b[31m",   // red
  WARN:  "\x1b[33m",   // yellow
  ERROR: "\x1b[31m",   // red bold
  DEBUG: "\x1b[90m",   // gray
};
const RESET = "\x1b[0m";

export class Logger {
  private logFile: fs.WriteStream | null = null;

  constructor(logDir?: string) {
    if (logDir) {
      fs.mkdirSync(logDir, { recursive: true });
      const filename = `bot-${new Date().toISOString().slice(0, 10)}.log`;
      this.logFile = fs.createWriteStream(path.join(logDir, filename), { flags: "a" });
    }
  }

  private log(level: Level, msg: string): void {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level.padEnd(5)}] ${msg}`;
    console.log(`${COLORS[level]}${line}${RESET}`);
    this.logFile?.write(line + "\n");
  }

  info(msg: string)  { this.log("INFO", msg); }
  trade(msg: string) { this.log("TRADE", msg); }
  risk(msg: string)  { this.log("RISK", msg); }
  warn(msg: string)  { this.log("WARN", msg); }
  error(msg: string) { this.log("ERROR", msg); }
  debug(msg: string) { this.log("DEBUG", msg); }

  close() { this.logFile?.end(); }
}
