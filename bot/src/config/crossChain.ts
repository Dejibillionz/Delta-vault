/**
 * Cross-Chain Configuration
 * Controls cross-chain funding arbitrage behavior.
 */

export const CROSS_CHAIN_CONFIG = {
  // Enable/disable cross-chain module
  ENABLED: true,

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

  // Keep true for hackathon safety
  SIMULATION_MODE: true,
} as const;