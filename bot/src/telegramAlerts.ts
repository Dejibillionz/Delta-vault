/**
 * Telegram Alerts
 * Sends real-time notifications for trades, risk events, and cycle summaries.
 *
 * Setup:
 *   1. Message @BotFather on Telegram → /newbot → copy the token
 *   2. Message @userinfobot to get your chat ID
 *   3. Add to .env:
 *        TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
 *        TELEGRAM_CHAT_ID=987654321
 *
 * If TELEGRAM_BOT_TOKEN is not set, all methods silently no-op.
 */

import axios from "axios";

type AlertLevel = "INFO" | "TRADE" | "RISK" | "CRITICAL";

interface TelegramMessage {
  level: AlertLevel;
  title: string;
  body: string;
  txSig?: string;
}

// Emoji per level
const EMOJI: Record<AlertLevel, string> = {
  INFO:     "ℹ️",
  TRADE:    "💚",
  RISK:     "⚠️",
  CRITICAL: "🚨",
};

export class TelegramAlerts {
  private token: string | null;
  private chatId: string | null;
  private baseUrl: string;
  private enabled: boolean;
  private queue: TelegramMessage[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  // Throttle: max 1 message per second (Telegram rate limit is 30/s but be conservative)
  private lastSent: number = 0;
  private readonly MIN_INTERVAL_MS = 1500;

  constructor() {
    this.token   = process.env.TELEGRAM_BOT_TOKEN || null;
    this.chatId  = process.env.TELEGRAM_CHAT_ID   || null;
    this.baseUrl = `https://api.telegram.org/bot${this.token}`;
    this.enabled = !!(this.token && this.chatId);

    if (this.enabled) {
      console.log("[TelegramAlerts] Enabled ✓");
    } else {
      console.log("[TelegramAlerts] Disabled — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env to enable");
    }
  }

  // ── Core send ────────────────────────────────────────────────────────────
  async send(msg: TelegramMessage): Promise<void> {
    if (!this.enabled) return;

    // Throttle
    const now = Date.now();
    const wait = this.MIN_INTERVAL_MS - (now - this.lastSent);
    if (wait > 0) await sleep(wait);

    const emoji = EMOJI[msg.level];
    const explorer = msg.txSig
      ? `\n🔗 <a href="https://solscan.io/tx/${msg.txSig}?cluster=devnet">View tx</a>`
      : "";

    const text = [
      `${emoji} <b>${msg.title}</b>`,
      `<code>${msg.body}</code>`,
      explorer,
    ].filter(Boolean).join("\n");

    try {
      await axios.post(`${this.baseUrl}/sendMessage`, {
        chat_id:    this.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }, { timeout: 5000 });
      this.lastSent = Date.now();
    } catch (err: any) {
      // Never crash the bot over a failed alert
      console.warn(`[TelegramAlerts] Send failed: ${err.message}`);
    }
  }

  // ── Convenience methods ───────────────────────────────────────────────────
  async botStarted(walletAddress: string, network: string): Promise<void> {
    await this.send({
      level: "INFO",
      title: "Delta Vault Bot Started",
      body: [
        `Network: ${network}`,
        `Wallet:  ${walletAddress.slice(0, 8)}...${walletAddress.slice(-4)}`,
        `Time:    ${new Date().toUTCString()}`,
      ].join("\n"),
    });
  }

  async tradeOpened(asset: string, type: string, sizeUsd: number, txSig?: string): Promise<void> {
    await this.send({
      level: "TRADE",
      title: `${asset} ${type} Position Opened`,
      body: [
        `Asset:  ${asset}`,
        `Type:   ${type}`,
        `Size:   $${sizeUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
        `Legs:   Spot long (Jupiter) + Perp short (Drift)`,
      ].join("\n"),
      txSig,
    });
  }

  async tradeClosed(asset: string, pnl: number, txSig?: string): Promise<void> {
    const sign = pnl >= 0 ? "+" : "";
    await this.send({
      level: "TRADE",
      title: `${asset} Position Closed`,
      body: [
        `Asset: ${asset}`,
        `PnL:   ${sign}$${Math.abs(pnl).toFixed(2)}`,
      ].join("\n"),
      txSig,
    });
  }

  async riskAlert(message: string, drawdownPct: number, deltaPct: number): Promise<void> {
    await this.send({
      level: "RISK",
      title: "Risk Alert",
      body: [
        message,
        `Drawdown:       ${(drawdownPct * 100).toFixed(2)}%`,
        `Delta exposure: ${(deltaPct * 100).toFixed(2)}%`,
      ].join("\n"),
    });
  }

  async emergencyStop(reason: string): Promise<void> {
    await this.send({
      level: "CRITICAL",
      title: "🚨 EMERGENCY STOP TRIGGERED",
      body: [
        `Reason: ${reason}`,
        `Action: All positions being closed`,
        `Time:   ${new Date().toUTCString()}`,
      ].join("\n"),
    });
  }

  async cycleUpdate(params: {
    tick: number;
    nav: number;
    pnl: number;
    positions: number;
    btcSignal: string;
    ethSignal: string;
  }): Promise<void> {
    const { tick, nav, pnl, positions, btcSignal, ethSignal } = params;
    const sign = pnl >= 0 ? "+" : "";
    // Only send every 10 cycles to avoid spam
    if (tick % 10 !== 0) return;
    await this.send({
      level: "INFO",
      title: `Cycle #${tick} Update`,
      body: [
        `NAV:        $${nav.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
        `PnL:        ${sign}$${Math.abs(pnl).toFixed(2)}`,
        `Positions:  ${positions} open`,
        `BTC signal: ${btcSignal}`,
        `ETH signal: ${ethSignal}`,
      ].join("\n"),
    });
  }

  async oracleStale(asset: string, ageSeconds: number): Promise<void> {
    await this.send({
      level: "RISK",
      title: `Oracle Stale — ${asset}`,
      body: `Price data is ${ageSeconds}s old (max 30s). Halting new positions.`,
    });
  }

  async networkCongested(latencyMs: number): Promise<void> {
    await this.send({
      level: "RISK",
      title: "Solana Network Congestion",
      body: `RPC latency: ${latencyMs}ms (threshold: 500ms)\nExecution paused until network clears.`,
    });
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Singleton export
export const telegram = new TelegramAlerts();
