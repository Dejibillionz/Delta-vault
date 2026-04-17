/**
 * Token Configuration
 * Centralized registry of token mint addresses and decimals
 * Update here to add support for new assets
 */

export const TOKEN_MINTS: Record<string, string> = {
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  BTC:  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", // Portal wBTC
  ETH:  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", // Portal wETH
  SOL:  "So11111111111111111111111111111111111111112",    // WSOL
  JTO:  "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",  // JTO
};

export const TOKEN_DECIMALS: Record<string, number> = {
  USDC: 6,
  BTC: 8,
  ETH: 8,
  SOL: 9,
  JTO: 9,
};

/**
 * Get mint address for an asset
 * @param asset Asset symbol (e.g., "BTC", "ETH")
 * @returns Mint address or undefined if asset not configured
 */
export function getMint(asset: string): string | undefined {
  return TOKEN_MINTS[asset];
}

/**
 * Get token decimals for an asset
 * @param asset Asset symbol
 * @returns Decimal places or undefined if asset not configured
 */
export function getDecimals(asset: string): number | undefined {
  return TOKEN_DECIMALS[asset];
}

/**
 * Check if an asset is configured
 */
export function isAssetConfigured(asset: string): boolean {
  return asset in TOKEN_MINTS && asset in TOKEN_DECIMALS;
}

/**
 * Register a new token (e.g., for testing or custom assets)
 */
export function registerToken(asset: string, mint: string, decimals: number): void {
  TOKEN_MINTS[asset] = mint;
  TOKEN_DECIMALS[asset] = decimals;
}
