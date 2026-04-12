/**
 * TradeRecord — PnL attribution per completed trade.
 * Built on close; stored in memory (last 100) and broadcast via bot state API.
 */

export interface TradeRecord {
  id: string;
  asset: string;
  openedAt: number;       // Unix ms
  closedAt: number;       // Unix ms
  notionalUsd: number;
  side: "LONG" | "SHORT"; // perp side

  // Prices
  entryPerpPrice: number;
  exitPerpPrice: number;
  entryFundingApr: number; // at entry
  exitFundingApr: number;  // at exit

  // Duration
  holdDurationMs: number;

  // PnL components (all in USD)
  fundingYieldUsd: number;    // accrued funding from perp position
  basisPnlUsd: number;        // spot price movement PnL
  entrySlippageUsd: number;   // cost of entry slippage
  exitSlippageUsd: number;    // cost of exit slippage
  netPnlUsd: number;          // sum of above

  venue: "HL" | "Bybit";
}
