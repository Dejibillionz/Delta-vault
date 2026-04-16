import React, { createContext, useState } from "react";
import { LogEntry, RiskEvent, DvModal } from "../types";

export interface UIContextType {
  running: boolean;
  setRunning: (running: boolean) => void;
  tab: "dashboard" | "architecture" | "how";
  setTab: (tab: "dashboard" | "architecture" | "how") => void;
  logs: LogEntry[];
  setLogs: (logs: LogEntry[]) => void;
  addLog: (type: string, msg: string) => void;
  riskFlags: RiskEvent[];
  setRiskFlags: (flags: RiskEvent[]) => void;
  tick: number;
  setTick: (tick: number) => void;
  dvModal: DvModal;
  setDvModal: (modal: DvModal) => void;
}

export const UIContext = createContext<UIContextType | undefined>(undefined);

export const UIProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [running, setRunning] = useState(true);
  const [tab, setTab] = useState<"dashboard" | "architecture" | "how">(
    "dashboard"
  );
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [riskFlags, setRiskFlags] = useState<RiskEvent[]>([]);
  const [tick, setTick] = useState(0);
  const [dvModal, setDvModal] = useState<DvModal>({
    open: false,
    tab: "deposit",
    amount: "",
    status: "idle",
    txSig: "",
    error: "",
  });

  const addLog = (type: string, msg: string) => {
    const now = new Date().toTimeString().slice(0, 8);
    setLogs((prev) => [
      ...prev.slice(-200),
      {
        id: Math.random(),
        type: type as any,
        msg,
        time: now,
      },
    ]);
  };

  const value: UIContextType = {
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
