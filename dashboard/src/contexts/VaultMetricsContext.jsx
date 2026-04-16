import React, { createContext, useState } from "react";
import { VaultMetrics, PnLBreakdown, Position } from "../types";

export interface VaultMetricsContextType {
  vault: VaultMetrics;
  setVault: (vault: VaultMetrics) => void;
  positions: Position[];
  setPositions: (positions: Position[]) => void;
  pnlBreakdown: PnLBreakdown;
  setPnlBreakdown: (breakdown: PnLBreakdown) => void;
  historyPnl: number[];
  setHistoryPnl: (history: number[]) => void;
  historyBtc: number[];
  setHistoryBtc: (history: number[]) => void;
  historyEth: number[];
  setHistoryEth: (history: number[]) => void;
  historySol: number[];
  setHistorySol: (history: number[]) => void;
  historyJto: number[];
  setHistoryJto: (history: number[]) => void;
  historyDrawdown: number[];
  setHistoryDrawdown: (history: number[]) => void;
}

export const VaultMetricsContext = createContext<VaultMetricsContextType | undefined>(
  undefined
);

export const VaultMetricsProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [vault, setVault] = useState<VaultMetrics>({
    nav: 0,
    pnl: 0,
    drawdown: 0,
    delta: 0,
    hwm: 0,
    totalUnrealizedPnl: 0,
    equityTarget: 0,
  });
  const [positions, setPositions] = useState<Position[]>([]);
  const [pnlBreakdown, setPnlBreakdown] = useState<PnLBreakdown>({
    funding: 0,
    lending: 0,
    realized: 0,
  });
  const [historyPnl, setHistoryPnl] = useState<number[]>(Array(50).fill(0));
  const [historyBtc, setHistoryBtc] = useState<number[]>(Array(50).fill(68450));
  const [historyEth, setHistoryEth] = useState<number[]>(Array(50).fill(3515));
  const [historySol, setHistorySol] = useState<number[]>(Array(50).fill(148));
  const [historyJto, setHistoryJto] = useState<number[]>(Array(50).fill(3.2));
  const [historyDrawdown, setHistoryDrawdown] = useState<number[]>(
    Array(50).fill(0)
  );

  const value: VaultMetricsContextType = {
    vault,
    setVault,
    positions,
    setPositions,
    pnlBreakdown,
    setPnlBreakdown,
    historyPnl,
    setHistoryPnl,
    historyBtc,
    setHistoryBtc,
    historyEth,
    setHistoryEth,
    historySol,
    setHistorySol,
    historyJto,
    setHistoryJto,
    historyDrawdown,
    setHistoryDrawdown,
  };

  return (
    <VaultMetricsContext.Provider value={value}>
      {children}
    </VaultMetricsContext.Provider>
  );
};

export const useVaultMetricsContext = () => {
  const context = React.useContext(VaultMetricsContext);
  if (!context) {
    throw new Error(
      "useVaultMetricsContext must be used within VaultMetricsProvider"
    );
  }
  return context;
};
