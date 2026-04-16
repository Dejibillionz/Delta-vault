import React from "react";
import { Card, SectionHead, Pill, Spark } from "../primitives";
import { useMarketDataContext } from "../contexts/MarketDataContext";
import { useVaultMetricsContext } from "../contexts/VaultMetricsContext";
import { KpiCard } from "./KpiCard";

/**
 * Dashboard Engines Composite
 * Consolidates Market, Strategy, and Vault display logic
 * Replaces ~400 lines of App.jsx with reusable components
 */

export const MarketDataSection = React.memo(() => {
  const { prices, funding, basis, liquidity } = useMarketDataContext();

  return (
    <Card style={{ gridColumn: "1 / -1" }}>
      <SectionHead n="1" label="MARKET DATA" color="#5ba8d0" />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
        {(["BTC", "ETH", "SOL", "JTO"] as const).map((asset) => (
          <div key={asset} style={{ fontSize: 9, fontFamily: "monospace" }}>
            <div style={{ color: "#00ffa3", fontWeight: 700, marginBottom: 4 }}>
              {asset}
            </div>
            <div style={{ color: "#8aa0b8", fontSize: 8, lineHeight: 1.8 }}>
              <div>Spot: ${prices[asset]?.toFixed(0)}</div>
              <div>Funding: {(funding[asset] * 100).toFixed(4)}%/hr</div>
              <div>Basis: {(basis[asset] * 100).toFixed(2)}%</div>
              <div>Liquidity: ${(liquidity[asset] / 1e6).toFixed(1)}M</div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
});

MarketDataSection.displayName = "MarketDataSection";

export const VaultSummary = React.memo(() => {
  const { vault, positions } = useVaultMetricsContext();

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))", gap: 8 }}>
      <KpiCard
        label="EQUITY"
        value={vault.nav}
        unit="$"
        color="#00ffa3"
        details="NAV"
      />
      <KpiCard
        label="PNL"
        value={vault.pnl}
        unit="$"
        color={vault.pnl >= 0 ? "#00ffa3" : "#f87171"}
        details="Realized"
      />
      <KpiCard
        label="DRAWDOWN"
        value={vault.drawdown * 100}
        unit="%"
        color={vault.drawdown < 0.05 ? "#00ffa3" : vault.drawdown < 0.1 ? "#f59e0b" : "#f87171"}
        details="Max"
      />
      <KpiCard
        label="DELTA"
        value={vault.delta * 100}
        unit="%"
        color={Math.abs(vault.delta) < 0.05 ? "#00ffa3" : "#f59e0b"}
        details="Exposure"
      />
      <KpiCard
        label="POSITIONS"
        value={positions.length}
        color="#a78bfa"
        details="Open"
      />
    </div>
  );
});

VaultSummary.displayName = "VaultSummary";
