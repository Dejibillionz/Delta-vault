import { useMemo } from "react";
import { useVaultMetricsContext } from "../contexts/VaultMetricsContext";

/**
 * Hook to calculate and manage vault metrics
 * Computes derived values: APY, Sharpe ratio, efficiency, etc.
 */
export const useVaultMetrics = () => {
  const {
    vault,
    positions,
    pnlBreakdown,
    historyPnl,
    historyDrawdown,
  } = useVaultMetricsContext();

  // Calculate rolling APY
  const rollingAPY = useMemo(() => {
    if (historyPnl.length < 2) return 0;
    const recentPnl = historyPnl.slice(-20);
    const avgPerCycle = recentPnl.reduce((a, b) => a + b, 0) / recentPnl.length;
    const cycleSeconds = 15;
    const hoursPerYear = 365 * 24;
    const cyclesPerYear = (hoursPerYear * 3600) / cycleSeconds;
    return (avgPerCycle / vault.equityTarget) * cyclesPerYear;
  }, [historyPnl, vault.equityTarget]);

  // Calculate Sharpe ratio (simplified)
  const sharpeRatio = useMemo(() => {
    if (historyPnl.length < 2) return 0;
    const mean = historyPnl.reduce((a, b) => a + b, 0) / historyPnl.length;
    const variance =
      historyPnl.reduce((a, v) => a + Math.pow(v - mean, 2), 0) / historyPnl.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev === 0) return 0;
    const riskFreeRate = 0.01; // 1% annual
    return ((rollingAPY - riskFreeRate) / stdDev) * 100;
  }, [historyPnl, rollingAPY]);

  // Calculate capital efficiency (how many dollars of PnL per dollar of capital)
  const capitalEfficiency = useMemo(() => {
    if (vault.equityTarget === 0) return 0;
    return (vault.totalUnrealizedPnl / vault.equityTarget) * 100;
  }, [vault.equityTarget, vault.totalUnrealizedPnl]);

  // Win rate (% of positive cycles)
  const winRate = useMemo(() => {
    if (historyPnl.length === 0) return 0;
    const wins = historyPnl.filter((v) => v > 0).length;
    return (wins / historyPnl.length) * 100;
  }, [historyPnl]);

  return {
    vault,
    positions,
    pnlBreakdown,
    historyPnl,
    historyDrawdown,
    // Derived metrics
    rollingAPY,
    sharpeRatio,
    capitalEfficiency,
    winRate,
  };
};
