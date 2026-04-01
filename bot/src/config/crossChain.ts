/**
 * Cross-Chain Configuration
 * Controls cross-chain funding arbitrage behavior.
 */

export const CROSS_CHAIN_CONFIG = {
  // Enable/disable cross-chain module
  ENABLED: true,

  // Chains to scan for funding opportunities
  CHAINS: ["solana", "arbitrum", "base", "optimism", "polygon", "avalanche", "bnb"] as const,

  // Minimum net edge after costs to execute (1.5%)
  MIN_NET_EDGE: 0.015,

  // Maximum capital allocation per cross-chain move (30%)
  MAX_ALLOCATION: 0.3,

  // Cooldown between cross-chain moves (1 hour)
  COOLDOWN_MS: 60 * 60 * 1000,

  // Risk penalty buffer for uncertainty (0.5%)
  RISK_PENALTY: 0.005,

  // Maximum expected bridge time in seconds (10 minutes)
  MAX_BRIDGE_TIME: 600,

  // Profit projection window for funding carry (hours)
  // We compare one-time move costs vs projected funding edge over this horizon.
  PROFIT_HORIZON_HOURS: 24,

  // true = log-only (no real bridge/execution). Auto-enabled on devnet.
  // Set to false only when real bridge SDK is integrated.
  SIMULATION_MODE: process.env.SOLANA_NETWORK !== "mainnet-beta" || true,
} as const;