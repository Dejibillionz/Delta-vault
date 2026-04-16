import React, { createContext, useState } from "react";

export const VaultMetricsContext = createContext(undefined);

export const VaultMetricsProvider = ({ children }) => {
  const [vault, setVault] = useState({
    nav: 0,
    pnl: 0,
    drawdown: 0,
    delta: 0,
    hwm: 0,
    totalUnrealizedPnl: 0,
    equityTarget: 0,
  });
  const [positions, setPositions] = useState([]);
  const [pnlBreakdown, setPnlBreakdown] = useState({
    funding: 0,
    lending: 0,
    realized: 0,
  });
  const [historyPnl, setHistoryPnl] = useState(Array(50).fill(0));
  const [historyBtc, setHistoryBtc] = useState(Array(50).fill(68450));
  const [historyEth, setHistoryEth] = useState(Array(50).fill(3515));
  const [historySol, setHistorySol] = useState(Array(50).fill(148));
  const [historyJto, setHistoryJto] = useState(Array(50).fill(3.2));
  const [historyDrawdown, setHistoryDrawdown] = useState(Array(50).fill(0));

  const value = {
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
