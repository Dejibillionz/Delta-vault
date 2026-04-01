/**
 * Fee Economics Calculator
 * Ensures trades are economically viable for small capital
 */

export interface FeeEstimate {
  driftSpotEntry: number;    // ~0.1% taker fee (Drift spot)
  driftSpotExit: number;     // ~0.1% taker fee (Drift spot)
  driftPerpEntry: number;    // ~0.1% taker fee (Drift perp)
  driftPerpExit: number;     // ~0.1% taker fee (Drift perp)
  priorityFee: number;       // ~0.00002 SOL per tx
  rentExemption: number;     // One-time ~0.002 SOL per new token account
  totalRoundTrip: number;
  breakEvenFundingRate: number; // Minimum funding rate needed to profit
}

export class FeeCalculator {
  private static SOL_PRICE_USD = 150; // Update dynamically in production

  static estimateFees(notionalUSD: number, isNewTokenAccount: boolean = false): FeeEstimate {
    // Drift perp taker fees: 0.1% per trade
    const driftPerpEntry = notionalUSD * 0.001;
    const driftPerpExit = notionalUSD * 0.001;

    // Drift spot taker fees: ~0.1% per trade (taker)
    const driftSpotEntry = notionalUSD * 0.001;
    const driftSpotExit = notionalUSD * 0.001;

    // Solana priority fees: 20,000 microlamports/CU * 200,000 CU avg = 0.004 SOL
    // 2 txs per leg (4 total) = 0.016 SOL ≈ $2.40 at $150/SOL
    // But with $10, we use minimal priority: 0.00001 SOL = $0.0015 per tx
    const priorityFee = 0.00001 * 4 * this.SOL_PRICE_USD; // 4 txs

    // Token account rent exemption (one-time per new asset)
    const rentExemption = isNewTokenAccount ? 0.002039 * this.SOL_PRICE_USD : 0;

    const totalRoundTrip = driftSpotEntry + driftSpotExit + driftPerpEntry + driftPerpExit + priorityFee + rentExemption;

    // Break-even: need to earn at least total fees in funding payments
    // Assuming 1-hour hold time for funding rate arbitrage
    const breakEvenFundingRate = totalRoundTrip / notionalUSD; // As decimal (e.g., 0.008 = 0.8%)

    return {
      driftSpotEntry,
      driftSpotExit,
      driftPerpEntry,
      driftPerpExit,
      priorityFee,
      rentExemption,
      totalRoundTrip,
      breakEvenFundingRate
    };
  }

  static isEconomicallyViable(notionalUSD: number, expectedFundingRate: number, holdTimeHours: number = 1): boolean {
    const fees = this.estimateFees(notionalUSD);

    // Expected funding income: fundingRate * notional * holdTime
    const expectedIncome = Math.abs(expectedFundingRate) * notionalUSD * (holdTimeHours / 8760); // 8760 hours/year

    // Must earn at least 1.5x fees to account for volatility risk
    const requiredIncome = fees.totalRoundTrip * 1.5;

    return expectedIncome >= requiredIncome;
  }

  static validateMinimumCapital(notionalUSD: number, asset: "BTC" | "ETH"): { valid: boolean; reason?: string } {
    // Drift minimum order sizes
    const MIN_ORDER_SIZES = {
      BTC: 0.001,  // ~$30 at $30k/BTC
      ETH: 0.01    // ~$30 at $3k/ETH
    };

    const MIN_NOTIONAL = {
      BTC: 30,
      ETH: 30
    };

    if (notionalUSD < MIN_NOTIONAL[asset]) {
      return {
        valid: false,
        reason: `Insufficient capital: $${notionalUSD} < $${MIN_NOTIONAL[asset]} minimum for ${asset} (min order: ${MIN_ORDER_SIZES[asset]})`
      };
    }

    // Fee check: fees should be < 2% of capital (otherwise too expensive)
    const fees = this.estimateFees(notionalUSD);
    const feePct = (fees.totalRoundTrip / notionalUSD) * 100;

    if (feePct > 2.0) {
      return {
        valid: false,
        reason: `Fee too high: ${feePct.toFixed(1)}% of capital. Minimum $${Math.ceil(fees.totalRoundTrip * 50)} recommended.`
      };
    }

    return { valid: true };
  }
}
