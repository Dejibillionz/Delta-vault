import React, { createContext, useState } from "react";

export const UIContext = createContext(undefined);

export const UIProvider = ({ children }) => {
  const [running, setRunning] = useState(true);
  const [tab, setTab] = useState("dashboard");
  const [logs, setLogs] = useState([]);
  const [riskFlags, setRiskFlags] = useState([]);
  const [tick, setTick] = useState(0);
  const [dvModal, setDvModal] = useState({
    open: false,
    tab: "deposit",
    amount: "",
    status: "idle",
    txSig: "",
    error: "",
  });

  const addLog = (type, msg) => {
    const now = new Date().toTimeString().slice(0, 8);
    setLogs((prev) => [
      ...prev.slice(-200),
      {
        id: Math.random(),
        type,
        msg,
        time: now,
      },
    ]);
  };

  const value = {
    running,
    setRunning,
    tab,
    setTab,
    logs,
    setLogs,
    addLog,
    riskFlags,
    setRiskFlags,
    tick,
    setTick,
    dvModal,
    setDvModal,
  };

  return <UIContext.Provider value={value}>{children}</UIContext.Provider>;
};

export const useUIContext = () => {
  const context = React.useContext(UIContext);
  if (!context) {
    throw new Error("useUIContext must be used within UIProvider");
  }
  return context;
};
