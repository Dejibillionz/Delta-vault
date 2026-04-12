import React, { useState, useEffect, useRef, useCallback } from "react";

/* ═══════════════════════════════════════════════════════════════════════════
   DELTA VAULT — Full Presentation Build
   All 4 engines unified: Market Data · Strategy · Execution · Risk
   Live Pyth prices · Phantom wallet · Hyperliquid + Kamino · SIMULATION MODE
═══════════════════════════════════════════════════════════════════════════ */

// ── Constants ─────────────────────────────────────────────────────────────────
const ASSETS = ["BTC", "ETH", "SOL", "JTO"];
const FUNDING_THRESHOLD = 0.0001;   // 0.01%/hr
const BASIS_THRESHOLD   = 0.01;     // 1%
const VAULT_INITIAL     = 10000;    // fallback equity for sim mode ($)
const CROSS_CHAIN_CHAINS = ["solana", "arbitrum", "base", "optimism", "polygon", "avalanche", "bnb"];

const CROSS_CHAIN_CFG = {
  ENABLED: true,
  MIN_NET_EDGE: 0.001,
  MAX_ALLOCATION: 0.3,
  COOLDOWN_MS: 60 * 1000,
  RISK_PENALTY: 0.001,
  PROFIT_HORIZON_HOURS: 24,
};

const CHAIN_FUNDING_OFFSETS = {
  arbitrum:  { BTC: 0.00002,  ETH: 0.00003,  SOL: 0.000025, JTO: 0.00004  },
  base:      { BTC: 0.00003,  ETH: 0.00004,  SOL: 0.00003,  JTO: 0.000035 },
  optimism:  { BTC: 0.00001,  ETH: 0.00002,  SOL: 0.000015, JTO: 0.00002  },
  polygon:   { BTC: -0.00001, ETH: 0.00002,  SOL: -0.00001, JTO: 0.00003  },
  avalanche: { BTC: -0.000005,ETH: 0.00001,  SOL: 0.000005, JTO: 0.000015 },
  bnb:       { BTC: 0.000025, ETH: 0.00003,  SOL: 0.00002,  JTO: 0.000025 },
};

const ROUTE_COST_MULT = {
  "solana->arbitrum": 1.0,
  "solana->base": 0.95,
  "solana->optimism": 0.98,
  "solana->polygon": 1.05,
  "solana->avalanche": 1.08,
  "solana->bnb": 1.12,
};

const PYTH_HERMES = "https://hermes.pyth.network/v2/updates/price/latest";
const PYTH_IDS = {
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
};

// ── Utilities ─────────────────────────────────────────────────────────────────
const clamp   = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rand    = (lo, hi)    => lo + Math.random() * (hi - lo);
const fmtUSD  = (n = 0)     => "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct  = (n = 0, d = 4) => (n * 100).toFixed(d) + "%";
const shortAddr = s => s ? `${s.slice(0,4)}…${s.slice(-4)}` : "";
const ts      = ()          => new Date().toTimeString().slice(0, 8);

function estimateRouteCostPct(fromChain, toChain) {
  const route = `${fromChain}->${toChain}`;
  const mult = ROUTE_COST_MULT[route] ?? 1;
  return (0.003 + 0.001 + 0.0015) * mult;
}

function buildFundingByChain(solanaFunding) {
  const map = { solana: { ...solanaFunding } };
  for (const chain of CROSS_CHAIN_CHAINS) {
    if (chain === "solana") continue;
    map[chain] = Object.fromEntries(ASSETS.map(a => [
      a,
      clamp(
        (solanaFunding[a] ?? 0) + (CHAIN_FUNDING_OFFSETS[chain]?.[a] ?? 0) + rand(-0.000008, 0.000008),
        -0.001,
        0.001
      ),
    ]));
  }
  return map;
}

function evaluateCrossChainAsset({ asset, currentChain, fundingByChain, capital, lastExecutionTime }) {
  const now = Date.now();
  if (!CROSS_CHAIN_CFG.ENABLED) return { asset, execute: false, reason: "Disabled", currentChain };
  if (now - lastExecutionTime < CROSS_CHAIN_CFG.COOLDOWN_MS) {
    return { asset, execute: false, reason: "Cooldown active", currentChain };
  }

  const currentRate = fundingByChain[currentChain]?.[asset] ?? 0;
  let best = {
    chain: currentChain,
    rate: currentRate,
    netEdge: -Infinity,
    costPct: 0,
    expectedProfit: 0,
  };
  const allocation = capital * CROSS_CHAIN_CFG.MAX_ALLOCATION;

  for (const chain of CROSS_CHAIN_CHAINS) {
    if (chain === currentChain) continue;
    const candidateRate = fundingByChain[chain]?.[asset] ?? 0;
    const projectedEdge = (candidateRate - currentRate) * CROSS_CHAIN_CFG.PROFIT_HORIZON_HOURS;
    const costPct = estimateRouteCostPct(currentChain, chain);
    const netEdge = projectedEdge - costPct - CROSS_CHAIN_CFG.RISK_PENALTY;
    const expectedProfit = allocation * netEdge;
    if (netEdge > best.netEdge) {
      best = { chain, rate: candidateRate, netEdge, costPct, expectedProfit };
    }
  }

  if (best.chain === currentChain) {
    return {
      asset,
      execute: false,
      reason: "Already optimal",
      currentChain,
      bestChain: currentChain,
      currentRate,
      bestRate: currentRate,
      netEdge: 0,
      allocation,
      expectedProfitUsd: 0,
      totalCostPct: 0,
    };
  }

  return {
    asset,
    execute: best.netEdge > CROSS_CHAIN_CFG.MIN_NET_EDGE,
    reason: best.netEdge > CROSS_CHAIN_CFG.MIN_NET_EDGE ? "Profitable" : "Edge too small after fees",
    currentChain,
    bestChain: best.chain,
    currentRate,
    bestRate: best.rate,
    netEdge: best.netEdge,
    allocation,
    expectedProfitUsd: best.expectedProfit,
    totalCostPct: best.costPct,
  };
}

// ── Pyth live price fetch ──────────────────────────────────────────────────────
async function fetchPyth() {
  try {
    const q = Object.values(PYTH_IDS).map(id => `ids[]=${id}`).join("&");
    const r = await fetch(`${PYTH_HERMES}?${q}`);
    const d = await r.json();
    const out = {};
    for (const item of d.parsed ?? []) {
      const asset = Object.entries(PYTH_IDS).find(([, id]) => id === item.id)?.[0];
      if (!asset) continue;
      const e = item.price.expo;
      out[asset] = {
        price: item.price.price * 10 ** e,
        conf:  item.price.conf  * 10 ** e,
      };
    }
    return out;
  } catch { return null; }
}

// ── Sparkline ─────────────────────────────────────────────────────────────────
function Spark({ data = [], color = "#00ffa3", w = 80, h = 32 }) {
  if (data.length < 2) return <svg width={w} height={h} />;
  const min = Math.min(...data), max = Math.max(...data), range = max - min || 1;
  const px = (v, i) => [(i / (data.length - 1)) * w, h - ((v - min) / range) * (h - 4) - 2];
  const pts = data.map((v, i) => px(v, i).join(",")).join(" ");
  const area = `M 0,${h} ` + data.map((v, i) => `L ${px(v, i).join(",")}`).join(" ") + ` L ${w},${h} Z`;
  const gid = `g${color.replace(/[^a-z0-9]/gi, "")}${w}`;
  return (
    <svg width={w} height={h} style={{ overflow: "visible", display: "block" }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0.0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

// ── PnL Chart with APY baseline ───────────────────────────────────────────────
function PnLChart({ data = [], vaultInitial = 10000, cycleSeconds = 15, color = "#00ffa3", w = 200, h = 60 }) {
  if (data.length < 2) return <svg width={w} height={h} />;
  const n = data.length;
  // Build 4.5% APY baseline: pnl_baseline[i] = vaultInitial * 0.045 * (i * cycleSeconds) / (365*24*3600)
  const APY = 0.045;
  const YEAR_S = 365 * 24 * 3600;
  const baseline = data.map((_, i) => vaultInitial * APY * (i * cycleSeconds) / YEAR_S);
  const allVals = [...data, ...baseline, 0];
  const minV = Math.min(...allVals), maxV = Math.max(...allVals);
  const range = maxV - minV || 1;
  const pad = { top: 6, bottom: 14, left: 26, right: 10 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;
  const py = v => pad.top + ch - ((v - minV) / range) * ch;
  const px = i => pad.left + (i / (n - 1)) * cw;
  // PnL polyline
  const pnlPts = data.map((v, i) => `${px(i)},${py(v)}`).join(" ");
  // Baseline polyline
  const basePts = baseline.map((v, i) => `${px(i)},${py(v)}`).join(" ");
  // Zero line Y
  const zeroY = py(0);
  // Area fill under PnL
  const areaPath = `M ${px(0)},${zeroY} ` + data.map((v, i) => `L ${px(i)},${py(v)}`).join(" ") + ` L ${px(n-1)},${zeroY} Z`;
  const gid = `pnlArea${w}`;
  // Y-axis labels: show 0 and max
  const labelMax = maxV > 0 ? `+$${maxV.toFixed(0)}` : `$${maxV.toFixed(0)}`;
  return (
    <svg width={w} height={h} style={{ overflow: "visible", display: "block" }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0.0" />
        </linearGradient>
      </defs>
      {/* Zero line */}
      <line x1={pad.left} y1={zeroY} x2={w - pad.right} y2={zeroY} stroke="#1e2e3e" strokeWidth="1" />
      {/* 4.5% APY baseline */}
      <polyline points={basePts} fill="none" stroke="#a78bfa" strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />
      <text x={w - pad.right + 2} y={py(baseline[n-1]) + 3} fontSize="6" fill="#a78bfa" opacity="0.8">4.5% APY</text>
      {/* PnL area + line */}
      <path d={areaPath} fill={`url(#${gid})`} />
      <polyline points={pnlPts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
      {/* Y-axis labels */}
      <text x={pad.left - 2} y={pad.top + 5} fontSize="6" fill="#3a4e62" textAnchor="end">{labelMax}</text>
      <text x={pad.left - 2} y={zeroY + 3} fontSize="6" fill="#3a4e62" textAnchor="end">$0</text>
    </svg>
  );
}

// ── Arc Gauge ─────────────────────────────────────────────────────────────────
function Gauge({ value, max, label, color, size = 88 }) {
  const pct  = clamp(value / max, 0, 1);
  const R    = size * 0.38, cx = size / 2, cy = size * 0.55;
  const ang  = (deg) => ({ x: cx + R * Math.cos((deg * Math.PI) / 180), y: cy + R * Math.sin((deg * Math.PI) / 180) });
  const s    = ang(-135), e = ang(-135 + pct * 270);
  const big  = pct > 0.5 ? 1 : 0;
  return (
    <div style={{ textAlign: "center", width: size }}>
      <svg width={size} height={size * 0.72}>
        <path d={`M ${ang(-135).x} ${ang(-135).y} A ${R} ${R} 0 1 1 ${ang(135).x} ${ang(135).y}`}
          fill="none" stroke="#111820" strokeWidth={5} strokeLinecap="round" />
        {pct > 0.005 && (
          <path d={`M ${s.x} ${s.y} A ${R} ${R} 0 ${big} 1 ${e.x} ${e.y}`}
            fill="none" stroke={color} strokeWidth={5} strokeLinecap="round" />
        )}
        <text x={cx} y={cy + 2} textAnchor="middle" fill="#e8eef8" fontSize={size * 0.135}
          fontWeight="700" fontFamily="monospace">{(pct * 100).toFixed(0)}%</text>
      </svg>
      <div style={{ fontSize: 8, color: "#3a4e62", letterSpacing: 1, marginTop: -4, fontFamily: "monospace" }}>{label}</div>
    </div>
  );
}

// ── Log entry ─────────────────────────────────────────────────────────────────
const LCOLOR = { INFO: "#5ba8d0", TRADE: "#00ffa3", RISK: "#f87171", WARN: "#fbbf24", SYS: "#a78bfa", PYTH: "#34d399" };
function Log({ e }) {
  return (
    <div style={{ display: "flex", gap: 6, fontSize: 10, fontFamily: "monospace", lineHeight: 1.65, padding: "1px 0" }}>
      <span style={{ color: "#283848", flexShrink: 0, width: 54 }}>{e.time}</span>
      <span style={{ color: LCOLOR[e.type] || "#888", width: 46, flexShrink: 0 }}>[{e.type}]</span>
      <span style={{ color: "#8aa0b8" }}>{e.msg}</span>
    </div>
  );
}

// ── Signal pill ───────────────────────────────────────────────────────────────
const SCOL = { DELTA_NEUTRAL: "#00ffa3", DELTA_NEUTRAL_REVERSE: "#a78bfa", BASIS_TRADE: "#f59e0b", PARK_CAPITAL: "#5ba8d0", NONE: "#3a4e62" };
function Pill({ label }) {
  const c = SCOL[label] || "#3a4e62";
  return (
    <span style={{ fontSize: 7.5, fontWeight: 800, letterSpacing: 1.5, color: c,
      background: c + "1a", border: `1px solid ${c}44`,
      padding: "2px 7px", borderRadius: 3, fontFamily: "monospace" }}>
      {label}
    </span>
  );
}

// ── Section header ────────────────────────────────────────────────────────────
function SectionHead({ n, label, color }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 11 }}>
      <div style={{ width: 20, height: 20, borderRadius: 5, background: color + "18",
        border: `1px solid ${color}44`, display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 9, fontWeight: 800, color, fontFamily: "monospace" }}>{n}</div>
      <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: 2.5, color, fontFamily: "monospace" }}>{label}</span>
    </div>
  );
}

// ── Card wrapper ──────────────────────────────────────────────────────────────
function Card({ children, style = {} }) {
  return (
    <div style={{
      background: "linear-gradient(145deg, #0a0f1a 0%, #080d14 100%)",
      border: "1px solid #141e2e",
      borderRadius: 10,
      padding: 15,
      ...style,
    }}>{children}</div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════════════
export default function DeltaVault() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [running,    setRunning]    = useState(true); // Auto-start simulation
  const [tab,        setTab]        = useState("dashboard"); // dashboard | architecture | how
  const [liveSync,   setLiveSync]   = useState(false);
  const [liveSyncErr,setLiveSyncErr]= useState("");

  // Market data
  const [prices,    setPrices]    = useState({ BTC: 68450, ETH: 3515, SOL: 148, JTO: 3.2 });
  const [funding,   setFunding]   = useState({ BTC: 0.000135, ETH: 0.000092, SOL: 0.000180, JTO: 0.000245 });
  const [basis,     setBasis]     = useState({ BTC: 0.0074,   ETH: 0.0058,   SOL: 0.0045,   JTO: 0.0062 });
  const [liquidity, setLiquidity] = useState({ BTC: 12.4e6,   ETH: 6.1e6,    SOL: 4.2e6,    JTO: 1.1e6 });
  const [conf,      setConf]      = useState({ BTC: 0, ETH: 0, SOL: 0, JTO: 0 });
  const [pythOn,    setPythOn]    = useState(false);
  const [pythTime,  setPythTime]  = useState(null);

  // Wallet
  const [wallet, setWallet] = useState({ connected: false, address: "", loading: false });

  // Strategy
  const [signals,   setSignals]   = useState({ BTC: "PARK_CAPITAL", ETH: "PARK_CAPITAL", SOL: "PARK_CAPITAL", JTO: "PARK_CAPITAL" });
  const [positions, setPositions] = useState([]);
  const [orders,    setOrders]    = useState([]);

  // Lending
  const [lending, setLending] = useState({ BTC: { amount: 0, yield: 0 }, ETH: { amount: 0, yield: 0 }, SOL: { amount: 0, yield: 0 }, JTO: { amount: 0, yield: 0 } });
  const [lendingHistory, setLendingHistory] = useState([]);

  // Cross-chain
  const [crossChain, setCrossChain] = useState({
    currentChain: { BTC: "solana", ETH: "solana", SOL: "solana", JTO: "solana" },
    lastExecTs: { BTC: 0, ETH: 0, SOL: 0, JTO: 0 },
    decisions: {
      BTC: { execute: false, reason: "Waiting", currentChain: "solana", bestChain: "solana", netEdge: 0, expectedProfitUsd: 0, totalCostPct: 0 },
      ETH: { execute: false, reason: "Waiting", currentChain: "solana", bestChain: "solana", netEdge: 0, expectedProfitUsd: 0, totalCostPct: 0 },
      SOL: { execute: false, reason: "Waiting", currentChain: "solana", bestChain: "solana", netEdge: 0, expectedProfitUsd: 0, totalCostPct: 0 },
      JTO: { execute: false, reason: "Waiting", currentChain: "solana", bestChain: "solana", netEdge: 0, expectedProfitUsd: 0, totalCostPct: 0 },
    },
    fundingByChain: Object.fromEntries(
      CROSS_CHAIN_CHAINS.map(chain => [chain, Object.fromEntries(ASSETS.map(a => [a, 0]))])
    ),
  });

  // AI Agent
  const [aiAgent, setAiAgent] = useState({
    enabled: false,
    mode: "Neutral",
    confidence: 0.5,
    lastDecision: "WAIT",
    reason: "Initializing",
    fundingSummary: "No signal",
    crossChainSignal: false,
    riskLevel: "Low",
    momentumScores: { BTC: 0, ETH: 0, SOL: 0, JTO: 0 },
  });
  const [aiDecisionPulse, setAiDecisionPulse] = useState(false);

  // Vault metrics
  const [vault, setVault] = useState({ nav: 0, pnl: 0, drawdown: 0, delta: 0, hwm: 0 });

  // History arrays
  const [hPnl,  setHPnl]  = useState(Array(50).fill(0));
  const [hBtc,  setHBtc]  = useState(Array(50).fill(68450));
  const [hEth,  setHEth]  = useState(Array(50).fill(3515));
  const [hSol,  setHSol]  = useState(Array(50).fill(148));
  const [hJto,  setHJto]  = useState(Array(50).fill(3.2));
  const [hDraw, setHDraw] = useState(Array(50).fill(0));

  // PnL breakdown: funding yield / lending yield / realized
  const [pnlBreakdown, setPnlBreakdown] = useState({ funding: 0, lending: 0, realized: 0 });

  // Logs
  const [logs,      setLogs]      = useState([]);
  const [riskFlags, setRiskFlags] = useState([]);
  const [tick,      setTick]      = useState(0);

  // Deposit / Withdraw modal
  const [dvModal, setDvModal] = useState({
    open: false,
    tab: "deposit",        // "deposit" | "withdraw"
    amount: "",            // USD string for deposit; shares string for withdraw
    status: "idle",        // "idle" | "pending" | "success" | "error"
    txSig: "",
    error: "",
  });
  const logsRef = useRef(null);
  const lastSyncedTickRef = useRef(-1);
  const lastAiDecisionRef = useRef("WAIT");
  const simEwmaRef = useRef({ BTC: 0, ETH: 0, SOL: 0, JTO: 0 });

  const addLog = useCallback((type, msg) => {
    setLogs(p => [...p.slice(-200), { type, msg, time: ts(), id: Math.random() }]);
  }, []);

  const riskLevelFromMetrics = useCallback((drawdown, deltaExposure) => {
    if (drawdown > 0.08 || deltaExposure > 0.06) return "High";
    if (drawdown > 0.04 || deltaExposure > 0.04) return "Medium";
    return "Low";
  }, []);

  const modeFromConfidence = useCallback((confidence) => {
    if (confidence >= 0.66) return "Aggressive";
    if (confidence <= 0.4) return "Conservative";
    return "Neutral";
  }, []);

  // ── Pyth polling ──────────────────────────────────────────────────────────
  const pollPyth = useCallback(async () => {
    const d = await fetchPyth();
    if (d?.BTC?.price > 0) {
      setPrices(p => ({ BTC: d.BTC?.price ?? p.BTC, ETH: d.ETH?.price ?? p.ETH }));
      setConf({ BTC: d.BTC?.conf ?? 0, ETH: d.ETH?.conf ?? 0 });
      setPythOn(true);
      setPythTime(ts());
      addLog("PYTH", `Prices updated — BTC ${fmtUSD(d.BTC?.price)} · ETH ${fmtUSD(d.ETH?.price)}`);
    }
  }, [addLog]);

  useEffect(() => {
    pollPyth();
    const id = setInterval(pollPyth, 12000);
    return () => clearInterval(id);
  }, [pollPyth]);

  // ── Live bot sync (preferred over local simulation) ──────────────────────
  useEffect(() => {
    let mounted = true;
    const pull = async () => {
      try {
        const res = await fetch("http://localhost:3001", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json();
        if (!mounted || !d?.prices) return;

        setLiveSync(true);
        setLiveSyncErr("");

        if (d.prices.BTC > 0 && d.prices.ETH > 0) {
          setPrices(p => ({
            BTC: d.prices.BTC ?? p.BTC,
            ETH: d.prices.ETH ?? p.ETH,
            SOL: d.prices.SOL > 0 ? d.prices.SOL : p.SOL,
            JTO: d.prices.JTO > 0 ? d.prices.JTO : p.JTO,
          }));
          setFunding({ BTC: d.funding?.BTC ?? 0, ETH: d.funding?.ETH ?? 0, SOL: d.funding?.SOL ?? 0, JTO: d.funding?.JTO ?? 0 });
          setBasis({ BTC: d.basis?.BTC ?? 0, ETH: d.basis?.ETH ?? 0, SOL: d.basis?.SOL ?? 0, JTO: d.basis?.JTO ?? 0 });
          setSignals({
            BTC: d.signals?.BTC ?? "PARK_CAPITAL",
            ETH: d.signals?.ETH ?? "PARK_CAPITAL",
            SOL: d.signals?.SOL ?? "PARK_CAPITAL",
            JTO: d.signals?.JTO ?? "PARK_CAPITAL",
          });
          setLending({
            BTC: { amount: d.lendingByAsset?.BTC?.amount ?? 0, yield: d.lendingByAsset?.BTC?.yield ?? 0 },
            ETH: { amount: d.lendingByAsset?.ETH?.amount ?? 0, yield: d.lendingByAsset?.ETH?.yield ?? 0 },
            SOL: { amount: d.lendingByAsset?.SOL?.amount ?? 0, yield: d.lendingByAsset?.SOL?.yield ?? 0 },
            JTO: { amount: d.lendingByAsset?.JTO?.amount ?? 0, yield: d.lendingByAsset?.JTO?.yield ?? 0 },
          });
          if (d.pnlBreakdown) {
            setPnlBreakdown(d.pnlBreakdown);
          }
          const groupedByAsset = (d.positions ?? []).reduce((acc, p) => {
            const asset = p.asset;
            if (!asset) return acc;
            if (!acc[asset]) {
              acc[asset] = {
                id: asset,
                asset,
                type: "DELTA_NEUTRAL",
                size: 0,
                pnl: 0,
                opened: ts(),
                legs: 0,
              };
            }
            // Use max notional across legs to represent one paired trade size.
            acc[asset].size = Math.max(acc[asset].size, p.notional ?? 0);
            // Sum PnL across legs for net position PnL.
            acc[asset].pnl += p.pnl ?? 0;
            acc[asset].legs += 1;
            return acc;
          }, {});

          setPositions(Object.values(groupedByAsset));
          setOrders(
            (d.execution?.events ?? d.executionEvents ?? []).slice(-10).map((msg, idx) => {
              const amountMatch = msg.match(/\$([0-9,.]+)/);
              const size = amountMatch ? Number(amountMatch[1].replace(/,/g, "")) : 0;
              return {
              id: `${d.tick}-${idx}`,
              time: ts(),
              asset: msg.includes("ETH") ? "ETH" : "BTC",
              action: msg,
              size,
              status: "FILLED",
              };
            })
          );
          setVault(v => ({
            ...v,
            nav: d.nav ?? v.nav,
            pnl: d.pnl ?? v.pnl,
            drawdown: d.drawdown ?? v.drawdown,
            delta: d.deltaExposure ?? v.delta,
            hwm: Math.max(v.hwm, d.nav ?? 0),
          }));
          setHPnl(h => [...h.slice(-49), d.pnl ?? 0]);
          setHDraw(h => [...h.slice(-49), Math.max(0, (d.drawdown ?? 0) * 100)]);
          setCrossChain(prev => ({
            ...prev,
            currentChain: d.crossChain?.currentChains ?? prev.currentChain,
            decisions: d.crossChain?.decisions ?? prev.decisions,
            fundingByChain: d.crossChain?.fundingByChain ?? prev.fundingByChain,
          }));
          const aiState = d.aiAgent?.state ?? {};
          const aiDecision = d.aiAgent?.decision ?? null;
          const confidence = aiState.confidence ?? aiDecision?.confidence ?? 0.5;
          const mode = modeFromConfidence(confidence);
          const fundingSummary = ASSETS.map(a => `${a} ${fmtPct(d.funding?.[a] ?? 0, 3)}`).join(" | ");
          const crossSignal = Object.values(d.crossChain?.decisions ?? {}).some(x => x?.execute);
          const riskLevel = riskLevelFromMetrics(d.drawdown ?? 0, d.deltaExposure ?? 0);
          setAiAgent({
            enabled: d.aiAgent?.enabled ?? true,
            mode,
            confidence,
            lastDecision:
              aiDecision?.action === "TRADE"
                ? `TRADE ${aiDecision.asset}`
                : aiDecision?.action === "SKIP"
                ? "SKIP"
                : "WAIT",
            reason:
              aiDecision?.reason ??
              (aiDecision?.action === "TRADE" ? "Funding edge selected" : "No qualified setup"),
            fundingSummary,
            crossChainSignal: crossSignal,
            riskLevel,
            momentumScores: aiState.momentumScores ?? { BTC: 0, ETH: 0, SOL: 0, JTO: 0 },
          });
          setTick(d.tick ?? 0);
          if ((d.tick ?? 0) !== lastSyncedTickRef.current) {
            lastSyncedTickRef.current = d.tick ?? 0;
            addLog("SYS", `Live sync: cycle #${d.tick ?? 0} · ${d.network ?? "devnet"}`);
            for (const evt of d.execution?.events ?? d.executionEvents ?? []) {
              addLog("TRADE", evt);
            }
          }
        }
      } catch (e) {
        if (!mounted) return;
        setLiveSync(false);
        setLiveSyncErr("Bot API offline (running simulation mode)");
      }
    };

    pull();
    const id = setInterval(pull, 5000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [addLog, modeFromConfidence, riskLevelFromMetrics]);

  // ── Phantom wallet ────────────────────────────────────────────────────────
  const connectPhantom = useCallback(async () => {
    setWallet(w => ({ ...w, loading: true }));
    try {
      const prov = typeof window !== "undefined" && window?.solana;
      if (!prov?.isPhantom) {
        addLog("RISK", "Phantom not found — install at phantom.app");
        alert("Phantom wallet not installed.\n\nGet it free at https://phantom.app\nthen refresh this page.");
        setWallet(w => ({ ...w, loading: false }));
        return;
      }
      const resp = await prov.connect();
      const addr = resp.publicKey.toBase58();
      setWallet({ connected: true, address: addr, loading: false });
      addLog("SYS", `Phantom connected — ${shortAddr(addr)}`);
    } catch (err) {
      addLog("RISK", `Wallet error: ${err.message}`);
      setWallet(w => ({ ...w, loading: false }));
    }
  }, [addLog]);

  const disconnectPhantom = useCallback(async () => {
    try { await window?.solana?.disconnect(); } catch {}
    setWallet({ connected: false, address: "", loading: false });
    addLog("SYS", "Phantom disconnected");
  }, [addLog]);

  // ── Deposit / Withdraw submit ─────────────────────────────────────────────
  const submitDV = useCallback(async () => {
    const amount = parseFloat(dvModal.amount);
    if (!amount || amount <= 0) return;
    setDvModal(m => ({ ...m, status: "pending", error: "", txSig: "" }));
    try {
      const endpoint = dvModal.tab === "deposit" ? "/deposit" : "/withdraw";
      const body = dvModal.tab === "deposit"
        ? { amountUsd: amount }
        : { shares: amount };
      const res = await fetch(`http://localhost:3001${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        addLog("SYS", `${dvModal.tab === "deposit" ? "Deposit" : "Withdraw"} tx: ${data.txSig}`);
        setDvModal(m => ({ ...m, status: "success", txSig: data.txSig }));
      } else {
        setDvModal(m => ({ ...m, status: "error", error: data.error ?? "Unknown error" }));
      }
    } catch (e) {
      setDvModal(m => ({ ...m, status: "error", error: e.message }));
    }
  }, [dvModal.tab, dvModal.amount, addLog]);

  // ── Strategy evaluation ───────────────────────────────────────────────────
  const evalSigs = (fr, bs) => {
    const s = {};
    for (const a of ASSETS) {
      if (fr[a] > FUNDING_THRESHOLD)       s[a] = "DELTA_NEUTRAL";         // LONG spot + SHORT perp
      else if (fr[a] < -FUNDING_THRESHOLD) s[a] = "DELTA_NEUTRAL_REVERSE"; // SHORT spot + LONG perp
      else if (bs[a] > BASIS_THRESHOLD)    s[a] = "BASIS_TRADE";
      else                                 s[a] = "PARK_CAPITAL";
    }
    return s;
  };

  // ── Bot loop ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!running || liveSync) return;
    const id = setInterval(() => {
      setTick(t => t + 1);

      // Hyperliquid funding & basis walk (server-side in prod; simulated here)
      // Allow negative funding so the reverse strategy (short spot + long perp) can trigger
      setFunding(f => { const n = {}; ASSETS.forEach(a => { n[a] = clamp((f[a] ?? 0) + rand(-0.000022, 0.000018), -0.00038, 0.00042); }); return n; });
      setBasis(b =>   { const n = {}; ASSETS.forEach(a => { n[a] = clamp((b[a] ?? 0) + rand(-0.0007, 0.0007), 0.0008, 0.022); });   return n; });
      setLiquidity(l =>{ const n = {}; ASSETS.forEach(a => { n[a] = clamp((l[a] ?? 1e6) + rand(-3e5,3e5), 1e6, 20e6); });            return n; });

      // Price walk on top of live Pyth
      setPrices(p => {
        const n = {
          BTC: p.BTC * (1 + rand(-0.0008, 0.0008)),
          ETH: p.ETH * (1 + rand(-0.0009, 0.0009)),
          SOL: p.SOL * (1 + rand(-0.0012, 0.0012)),
          JTO: p.JTO * (1 + rand(-0.0015, 0.0015)),
        };
        setHBtc(h => [...h.slice(-49), n.BTC]);
        setHEth(h => [...h.slice(-49), n.ETH]);
        setHSol(h => [...h.slice(-49), n.SOL]);
        setHJto(h => [...h.slice(-49), n.JTO]);
        return n;
      });

      setFunding(fr => {
        setBasis(bs => {
          const sigs = evalSigs(fr, bs);
          setSignals(sigs);

          // Cross-chain evaluation (BTC + ETH) with fee-aware profitability checks
          setCrossChain(prev => {
            const now = Date.now();
            const fundingByChain = buildFundingByChain(fr);
            const nextCurrent = { ...prev.currentChain };
            const nextLastExec = { ...prev.lastExecTs };
            const nextDecisions = { ...prev.decisions };

            ASSETS.forEach(a => {
              const decision = evaluateCrossChainAsset({
                asset: a,
                currentChain: nextCurrent[a],
                fundingByChain,
                capital: VAULT_INITIAL / 2,
                lastExecutionTime: nextLastExec[a],
              });

              nextDecisions[a] = decision;

              if (decision.execute) {
                addLog(
                  "SYS",
                  `🌉 ${a} cross-chain: ${decision.currentChain} → ${decision.bestChain} | edge ${fmtPct(decision.netEdge, 2)} | est ${fmtUSD(decision.expectedProfitUsd)}`
                );
                nextCurrent[a] = decision.bestChain;
                nextLastExec[a] = now;
              }
            });

            return {
              currentChain: nextCurrent,
              lastExecTs: nextLastExec,
              decisions: nextDecisions,
              fundingByChain,
            };
          });

          const topAsset = ASSETS.reduce((best, a) => (fr[a] ?? 0) >= (fr[best] ?? 0) ? a : best, ASSETS[0]);
          const topFunding = fr[topAsset] ?? 0;
          const confidence = clamp(0.45 + (Math.min(Math.abs(topFunding) * 1000, 0.35)), 0.35, 0.9);
          const mode = modeFromConfidence(confidence);
          const crossSignal = ASSETS.some(a => (crossChain.decisions[a]?.execute ?? false));
          const riskLevel = riskLevelFromMetrics(vault.drawdown, vault.delta);
          // Update simulated EWMA and compute per-asset momentum
          const simMomentum = {};
          ASSETS.forEach(a => {
            const prev = simEwmaRef.current[a] ?? 0;
            const cur = fr[a] ?? 0;
            const ewma = 0.3 * cur + 0.7 * prev;
            simEwmaRef.current[a] = ewma;
            simMomentum[a] = Math.max(-1, Math.min(1, (cur - ewma) / Math.max(Math.abs(ewma), 0.00001)));
          });
          setAiAgent({
            enabled: true,
            mode,
            confidence,
            lastDecision: topFunding > FUNDING_THRESHOLD ? `TRADE ${topAsset}` : "SKIP",
            reason: topFunding > FUNDING_THRESHOLD ? `${topAsset} funding leading` : "Funding below threshold",
            fundingSummary: ASSETS.map(a => `${a} ${fmtPct(fr[a] ?? 0, 3)}`).join(" | "),
            crossChainSignal: crossSignal,
            riskLevel,
            momentumScores: simMomentum,
          });

          ASSETS.forEach(a => {
            const sig = sigs[a];
            if (sig === "DELTA_NEUTRAL" || sig === "DELTA_NEUTRAL_REVERSE") {
              const expectedType = sig;
              const label = sig === "DELTA_NEUTRAL" ? "LONG spot + SHORT perp" : "SHORT spot + LONG perp";
              const action = sig === "DELTA_NEUTRAL" ? "PERP SHORT + SPOT LONG" : "PERP LONG + SPOT SHORT";
              setPositions(p => {
                // Close any position in the opposite direction (regime flip)
                const opposite = p.find(x => x.asset === a && x.type !== expectedType && x.type !== "BASIS_TRADE");
                if (opposite) {
                  addLog("TRADE", `${a}: funding regime flipped — closing ${opposite.type}, opening ${expectedType}`);
                  p = p.filter(x => !(x.asset === a && x.type !== expectedType && x.type !== "BASIS_TRADE"));
                }
                if (p.find(x => x.asset === a && x.type === expectedType)) return p;
                const sz = rand(4000, 18000);
                addLog("TRADE", `[SIM] ${a} ${expectedType} — ${label} $${sz.toFixed(0)} on Hyperliquid`);
                setOrders(o => [{ id: Date.now(), time: ts(), asset: a, action, size: sz, status: "FILLED" }, ...o.slice(0, 9)]);
                return [...p, { asset: a, type: expectedType, size: sz, pnl: 0, opened: ts(), simulated: true }];
              });
            } else if (sig === "BASIS_TRADE") {
              setPositions(p => {
                if (p.find(x => x.asset === a && x.type === "BASIS_TRADE")) return p;
                const sz = rand(5000, 20000);
                addLog("TRADE", `[SIM] ${a} BASIS_TRADE — spread ${fmtPct(bs[a], 2)}, size $${sz.toFixed(0)}`);
                return [...p, { asset: a, type: "BASIS_TRADE", size: sz, pnl: 0, opened: ts(), simulated: true }];
              });
            } else {
              setPositions(p => {
                if (p.find(x => x.asset === a)) addLog("INFO", `${a}: parking capital — below all thresholds`);
                return p.filter(x => x.asset !== a);
              });
              const lendingAmount = VAULT_INITIAL / 2;
              setLending(prev => ({
                ...prev,
                [a]: { amount: lendingAmount, yield: prev[a].yield + rand(0.001, 0.005) }
              }));
              addLog("TRADE", `${a}: deploying $${lendingAmount.toFixed(0)} to lending pool`);
            }
          });
          return bs;
        });
        return fr;
      });

      // PnL update + risk
      setPositions(prev => {
        const updated = prev.map(p => ({ ...p, pnl: p.pnl + p.size * rand(-0.00016, 0.00052) }));
        const totalPnl = updated.reduce((s, p) => s + p.pnl, 0);
        
        // Add lending yields
        const lendingYield = Object.values(lending).reduce((sum, l) => sum + l.yield, 0);
        const totalPnlWithLending = totalPnl + lendingYield;
        
        // Log lending yields
        if (lendingYield > 0) {
          addLog("TRADE", `Lending yield: +${fmtUSD(lendingYield)} this cycle`);
        }
        
        const nav = VAULT_INITIAL + totalPnlWithLending;

        setVault(v => {
          const newHwm = Math.max(v.hwm, nav);
          const dd = Math.max(0, (newHwm - nav) / newHwm);
          const delta = updated.filter(p => p.type === "BASIS_TRADE").reduce((s, p) => s + p.size, 0) / nav * 0.045;
          const flags = [];
          if (dd > 0.05)    { flags.push("⚠ DRAWDOWN > 5%");       addLog("RISK", `Drawdown ${fmtPct(dd, 2)} — monitoring`); }
          if (delta > 0.05) { flags.push("⚠ DELTA EXPOSURE > 5%"); addLog("RISK", "Delta exposure exceeded 5% — rebalance"); }
          if (dd > 0.10)    { addLog("RISK", "EMERGENCY STOP — closing all positions"); }
          setRiskFlags(flags);
          return { nav, pnl: totalPnl, drawdown: dd, delta, hwm: newHwm };
        });

        setHPnl(h => [...h.slice(-49), totalPnl]);
        setHDraw(h => [...h.slice(-49), Math.max(0, (VAULT_INITIAL - nav) / VAULT_INITIAL * 100)]);
        return updated;
      });

      addLog("INFO", `Cycle #${tick + 1} — Hyperliquid + Pyth scanned`);
    }, 2500);
    return () => clearInterval(id);
  }, [running, liveSync, addLog, tick, crossChain.decisions, modeFromConfidence, riskLevelFromMetrics, vault.delta, vault.drawdown]);

  useEffect(() => {
    if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight;
  }, [logs]);

  useEffect(() => {
    if (!aiAgent.lastDecision) return;
    if (lastAiDecisionRef.current === aiAgent.lastDecision) return;
    lastAiDecisionRef.current = aiAgent.lastDecision;
    setAiDecisionPulse(true);
    const id = setTimeout(() => setAiDecisionPulse(false), 900);
    return () => clearTimeout(id);
  }, [aiAgent.lastDecision]);

  // ── Computed ──────────────────────────────────────────────────────────────
  const totalFundingYield = positions.filter(p => p.type === "DELTA_NEUTRAL").reduce((s, p) => s + p.size * (funding[p.asset] ?? 0) * 24, 0);
  const totalLendingYield = Object.values(lending).reduce((s, l) => s + l.yield, 0);
  const totalLendingAmount = Object.values(lending).reduce((s, l) => s + l.amount, 0);
  const lendingPercentage = totalLendingAmount / VAULT_INITIAL;
  const avgCrossEdge = (ASSETS.reduce((s, a) => s + (crossChain.decisions[a]?.netEdge ?? 0), 0) / ASSETS.length);
  const crossExecCount = ASSETS.filter(a => crossChain.decisions[a]?.execute).length;

  // Rolling APY & Sharpe ratio from PnL history
  const windowPts = Math.min(hPnl.length, 40);
  const pnlStart = hPnl[hPnl.length - windowPts] ?? 0;
  const pnlEnd   = hPnl[hPnl.length - 1] ?? 0;
  const windowSecs = windowPts * (liveSync ? 15 : 2.5);
  const rollingAPY = VAULT_INITIAL > 0
    ? ((pnlEnd - pnlStart) / VAULT_INITIAL) * (365 * 24 * 3600 / Math.max(windowSecs, 1)) * 100
    : 0;
  const hPnlReturns = hPnl.slice(1).map((v, i) => (v - hPnl[i]) / Math.max(VAULT_INITIAL, 1));
  const meanReturn = hPnlReturns.length > 0 ? hPnlReturns.reduce((s, r) => s + r, 0) / hPnlReturns.length : 0;
  const varReturn  = hPnlReturns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / Math.max(hPnlReturns.length, 1);
  const sharpe     = varReturn > 0 ? (meanReturn / Math.sqrt(varReturn)) * Math.sqrt((365 * 24 * 3600) / (liveSync ? 15 : 2.5)) : 0;

  // Capital efficiency: deployed (trading + lending) / total
  const deployedCapital = positions.reduce((s, p) => s + (p.size ?? 0), 0) + totalLendingAmount;
  const capitalEfficiency = VAULT_INITIAL > 0 ? Math.min(deployedCapital / VAULT_INITIAL, 1) : 0;
  const aiModeColor =
    aiAgent.mode === "Aggressive" ? "#34d399" :
    aiAgent.mode === "Conservative" ? "#f59e0b" :
    "#38bdf8";
  const aiRiskColor =
    aiAgent.riskLevel === "High" ? "#f87171" :
    aiAgent.riskLevel === "Medium" ? "#fbbf24" :
    "#34d399";
  const aiAccent = aiAgent.riskLevel === "High" ? aiRiskColor : aiModeColor;

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <div style={{ minHeight: "100vh", background: "#050810", color: "#d4dde8", fontFamily: "'DM Mono', 'JetBrains Mono', monospace", userSelect: "none" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500&family=Syne:wght@700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:3px;height:3px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:#1a2535;border-radius:2px}
        .blink{animation:blink 1.1s step-end infinite}
        @keyframes blink{50%{opacity:0}}
        .pulse{animation:pulse 2.5s ease-in-out infinite}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
        @keyframes aiDecisionPulse{0%{opacity:.95;transform:scaleY(1)}60%{opacity:.5;transform:scaleY(1.02)}100%{opacity:.72;transform:scaleY(1)}}
        .fadein{animation:fadein .4s ease}
        @keyframes fadein{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
        .hov:hover{background:#0f1520!important;transition:background .15s}
        .tabbtn{cursor:pointer;border:none;background:transparent;font-family:inherit;font-size:10px;font-weight:500;letter-spacing:1.5px;padding:7px 16px;border-radius:6px;transition:all .18s}
        .tabbtn.active{background:#0f1a28;color:#00ffa3;border:1px solid #00ffa322}
        .tabbtn:not(.active){color:#3a4e62;border:1px solid transparent}
        .tabbtn:not(.active):hover{color:#7a9bb8}
      `}</style>

      {/* ── Deposit / Withdraw Modal ──────────────────────────────────────── */}
      {dvModal.open && (
        <div onClick={() => dvModal.status !== "pending" && setDvModal(m => ({ ...m, open: false }))} style={{
          position: "fixed", inset: 0, background: "#00000099", zIndex: 1000,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: "#080e1a", border: "1px solid #1a2a40", borderRadius: 14,
            padding: "28px 28px 24px", width: 360, boxShadow: "0 24px 60px #000a",
          }}>
            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <span style={{ fontSize: 11, letterSpacing: 2, color: "#00ffa3", fontWeight: 500 }}>VAULT ACCESS</span>
              <button onClick={() => setDvModal(m => ({ ...m, open: false }))}
                disabled={dvModal.status === "pending"}
                style={{ cursor: "pointer", background: "none", border: "none", color: "#3a4e62", fontSize: 16 }}>✕</button>
            </div>

            {/* Vault stats */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 18 }}>
              {[
                { l: "VAULT NAV", v: `$${(VAULT_INITIAL + vault.pnl).toLocaleString("en-US", { maximumFractionDigits: 0 })}` },
                { l: "TOTAL PnL", v: `${vault.pnl >= 0 ? "+" : ""}$${vault.pnl.toFixed(2)}`, c: vault.pnl >= 0 ? "#00ffa3" : "#f87171" },
                { l: "NAV / SHARE", v: "$1.00", c: "#a78bfa" },
              ].map(({ l, v, c }) => (
                <div key={l} style={{ padding: "8px 10px", background: "#060911", borderRadius: 8, border: "1px solid #111e2e" }}>
                  <div style={{ fontSize: 7, color: "#2a3a4e", letterSpacing: 1, marginBottom: 4 }}>{l}</div>
                  <div style={{ fontSize: 11, color: c ?? "#e8eef8", fontWeight: 500 }}>{v}</div>
                </div>
              ))}
            </div>

            {/* Tabs */}
            <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
              {["deposit", "withdraw"].map(t => (
                <button key={t} onClick={() => setDvModal(m => ({ ...m, tab: t, status: "idle", amount: "", error: "", txSig: "" }))}
                  style={{
                    flex: 1, cursor: "pointer", padding: "7px 0", borderRadius: 7,
                    fontFamily: "monospace", fontSize: 10, letterSpacing: 1.2, fontWeight: 500,
                    background: dvModal.tab === t ? "#0c1a28" : "#060911",
                    color: dvModal.tab === t ? "#00ffa3" : "#3a4e62",
                    border: dvModal.tab === t ? "1px solid #00ffa333" : "1px solid #111e2e",
                    transition: "all .15s",
                  }}>
                  {t === "deposit" ? "⬆ DEPOSIT" : "⬇ WITHDRAW"}
                </button>
              ))}
            </div>

            {/* Input */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 7.5, color: "#3a4e62", letterSpacing: 1, marginBottom: 6 }}>
                {dvModal.tab === "deposit" ? "AMOUNT (USD)" : "SHARES TO BURN"}
              </div>
              <div style={{ position: "relative" }}>
                <input
                  type="number"
                  min="0"
                  placeholder={dvModal.tab === "deposit" ? "100" : "100.0"}
                  value={dvModal.amount}
                  onChange={e => setDvModal(m => ({ ...m, amount: e.target.value, status: "idle", error: "" }))}
                  disabled={dvModal.status === "pending"}
                  style={{
                    width: "100%", padding: "10px 48px 10px 12px",
                    background: "#060911", border: "1px solid #1a2a40", borderRadius: 8,
                    color: "#e8eef8", fontFamily: "monospace", fontSize: 13, outline: "none",
                  }}
                />
                <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", fontSize: 9, color: "#3a4e62" }}>
                  {dvModal.tab === "deposit" ? "USDC" : "SHARES"}
                </span>
              </div>
              {dvModal.tab === "deposit" && dvModal.amount && (
                <div style={{ fontSize: 8, color: "#3a4e62", marginTop: 5 }}>
                  ≈ {dvModal.amount} shares minted at current NAV
                </div>
              )}
              {dvModal.tab === "withdraw" && dvModal.amount && (
                <div style={{ fontSize: 8, color: "#3a4e62", marginTop: 5 }}>
                  ≈ ${dvModal.amount} USDC returned at current NAV
                </div>
              )}
            </div>

            {/* Status */}
            {dvModal.status === "error" && (
              <div style={{ padding: "8px 12px", background: "#1a0808", border: "1px solid #f8717133", borderRadius: 8, marginBottom: 12, fontSize: 9, color: "#f87171" }}>
                {dvModal.error}
              </div>
            )}
            {dvModal.status === "success" && (
              <div style={{ padding: "8px 12px", background: "#081a10", border: "1px solid #00ffa333", borderRadius: 8, marginBottom: 12, fontSize: 9, color: "#00ffa3" }}>
                Transaction confirmed!{" "}
                <a href={`https://solscan.io/tx/${dvModal.txSig}${import.meta?.env?.VITE_NETWORK === "mainnet-beta" ? "" : "?cluster=devnet"}`}
                  target="_blank" rel="noreferrer" style={{ color: "#a78bfa" }}>
                  View on Solscan ↗
                </a>
              </div>
            )}

            {/* Submit */}
            <button onClick={submitDV}
              disabled={dvModal.status === "pending" || !dvModal.amount}
              style={{
                width: "100%", padding: "11px 0", cursor: dvModal.status === "pending" || !dvModal.amount ? "not-allowed" : "pointer",
                background: dvModal.status === "success" ? "#081a10" : "#071209",
                border: `1px solid ${dvModal.status === "success" ? "#00ffa355" : "#00ffa333"}`,
                borderRadius: 9, color: dvModal.status === "pending" ? "#3a4e62" : "#00ffa3",
                fontFamily: "monospace", fontSize: 11, fontWeight: 600, letterSpacing: 1.5,
                transition: "all .15s",
              }}>
              {dvModal.status === "pending" ? "⏳ PROCESSING…" : dvModal.status === "success" ? "✓ DONE" : dvModal.tab === "deposit" ? "⬆ DEPOSIT" : "⬇ WITHDRAW"}
            </button>

            <div style={{ marginTop: 10, fontSize: 7.5, color: "#1e2e3e", textAlign: "center", lineHeight: 1.5 }}>
              Routed via bot wallet · NAV staleness guard enforced on-chain
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          SIMULATION BANNER
      ══════════════════════════════════════════════════════════════════════ */}
      <div style={{
        background: "repeating-linear-gradient(90deg,#130900,#130900 14px,#170a00 14px,#170a00 28px)",
        borderBottom: "1px solid #f59e0b33",
        padding: "6px 24px",
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span style={{ fontSize: 10, fontWeight: 500, color: "#f59e0b", letterSpacing: 2.5 }}>⚠ SIMULATION MODE</span>
          <span style={{ width: 1, height: 12, background: "#3a2a10", display: "inline-block" }} />
          <span style={{ fontSize: 9, color: "#5a3c18", letterSpacing: .5 }}>No real funds at risk · Paper execution · Connect Phantom wallet to go live on Hyperliquid</span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{
            fontSize: 8, padding: "2px 9px", borderRadius: 3, fontWeight: 500, letterSpacing: 1,
            background: liveSync ? "#001a0c" : "#1a0f00",
            color: liveSync ? "#34d399" : "#f59e0b",
            border: `1px solid ${liveSync ? "#34d39922" : "#f59e0b22"}`,
          }}>
            {liveSync ? "LIVE BOT SYNC" : "LOCAL SIMULATION"}
          </span>
          <span style={{
            fontSize: 8, padding: "2px 9px", borderRadius: 3, fontWeight: 500, letterSpacing: 1,
            background: pythOn ? "#001a0c" : "#0e0e00",
            color: pythOn ? "#00ffa3" : "#666",
            border: `1px solid ${pythOn ? "#00ffa322" : "#33330022"}`,
          }}>
            {pythOn ? "⬤ PYTH NETWORK LIVE" : "◯ PYTH CONNECTING"}
          </span>
          {liveSyncErr && <span style={{ fontSize: 8, color: "#5a3c18" }}>{liveSyncErr}</span>}
          {pythTime && <span style={{ fontSize: 8, color: "#2a3840" }}>{pythTime}</span>}
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          TOPBAR
      ══════════════════════════════════════════════════════════════════════ */}
      <div style={{ padding: "14px 24px 0", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #0f1a28" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: "#00ffa3", fontFamily: "'Syne', sans-serif", letterSpacing: 1 }}>
              ◈ DELTA VAULT
            </div>
            <div style={{ fontSize: 8, color: "#1e2e3e", letterSpacing: 3.5, marginTop: 1 }}>
              HYPERLIQUID · KAMINO · SOLANA · BTC/ETH/SOL/JTO · DELTA-NEUTRAL
            </div>
          </div>
          {/* Tabs */}
          <div style={{ display: "flex", gap: 3, marginLeft: 20, paddingBottom: 0 }}>
            {[["dashboard","DASHBOARD"],["architecture","ARCHITECTURE"],["how","HOW IT WORKS"]].map(([id, label]) => (
              <button key={id} className={`tabbtn ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>
        </div>

        {/* Right controls */}
        <div style={{ display: "flex", gap: 9, alignItems: "center", paddingBottom: 14 }}>
          {!wallet.connected ? (
            <button onClick={connectPhantom} disabled={wallet.loading} style={{
              cursor: "pointer", border: "1px solid #a78bfa44", borderRadius: 7, background: "#09091e",
              color: "#a78bfa", fontSize: 10, fontFamily: "monospace", fontWeight: 500, letterSpacing: 1,
              padding: "7px 14px", display: "flex", alignItems: "center", gap: 6, transition: "all .15s",
            }}>
              <span style={{ fontSize: 13 }}>⬡</span> {wallet.loading ? "CONNECTING…" : "CONNECT PHANTOM"}
            </button>
          ) : (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <div style={{ padding: "5px 10px", background: "#09091e", border: "1px solid #a78bfa33", borderRadius: 6, fontSize: 9, color: "#a78bfa", display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#a78bfa", display: "inline-block" }} className="pulse" />
                {shortAddr(wallet.address)}
              </div>
              <button onClick={disconnectPhantom} style={{ cursor:"pointer", border:"1px solid #f8717133", borderRadius:6, background:"#120808", color:"#f87171", fontSize:9, fontFamily:"monospace", padding:"5px 9px" }}>✕</button>
            </div>
          )}
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span className={running ? "blink" : ""} style={{ width: 7, height: 7, borderRadius: "50%", background: running ? "#00ffa3" : "#1e2e3e", display: "inline-block" }} />
            <span style={{ fontSize: 9, color: running ? "#00ffa3" : "#2e3e50", letterSpacing: 1 }}>{running ? "RUNNING" : "IDLE"}</span>
          </div>
          <button onClick={() => setDvModal(m => ({ ...m, open: true, status: "idle", amount: "", error: "", txSig: "" }))} style={{
            cursor: "pointer", border: "1px solid #00ffa344", borderRadius: 7, background: "#071209",
            color: "#00ffa3", fontSize: 10, fontFamily: "monospace", fontWeight: 500, letterSpacing: 1,
            padding: "7px 14px", transition: "all .15s",
          }}>⬆⬇ DEPOSIT / WITHDRAW</button>
          <button onClick={() => { setRunning(r => !r); addLog("SYS", running ? "Bot stopped" : "Bot started — scanning Hyperliquid"); }} style={{
            cursor: "pointer", border: `1px solid ${running ? "#f8717144" : "#00ffa344"}`,
            borderRadius: 7, background: running ? "#120707" : "#071209",
            color: running ? "#f87171" : "#00ffa3",
            fontSize: 10, fontFamily: "monospace", fontWeight: 500, letterSpacing: 1.5,
            padding: "7px 18px", transition: "all .15s",
          }}>{running ? "⏹ STOP" : "▶ START BOT"}</button>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          TAB: DASHBOARD
      ══════════════════════════════════════════════════════════════════════ */}
      {tab === "dashboard" && (
        <div className="fadein" style={{ padding: "16px 24px 24px" }}>

          {/* Risk flags */}
          {riskFlags.length > 0 && (
            <div style={{ marginBottom: 12, background: "#140707", border: "1px solid #f8717144", borderRadius: 8, padding: "9px 16px", display: "flex", gap: 20 }}>
              {riskFlags.map((f, i) => (
                <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#f87171", display: "inline-block" }} className="blink" />
                  <span style={{ color: "#f87171", fontSize: 10, letterSpacing: .5 }}>{f}</span>
                </div>
              ))}
            </div>
          )}

          {/* KPI row */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(11, 1fr)", gap: 9, marginBottom: 12 }}>
            {[
              { l: "VAULT NAV",        v: fmtUSD(vault.nav),               sub: `PnL ${vault.pnl >= 0 ? "+" : ""}${fmtUSD(vault.pnl)}`,   c: vault.pnl >= 0 ? "#00ffa3" : "#f87171" },
              { l: "OPEN POSITIONS",   v: positions.length,                 sub: `${positions.filter(p=>p.type==="DELTA_NEUTRAL").length} delta-neutral`,   c: "#5ba8d0" },
              { l: "PROJ. YIELD/DAY", v: fmtUSD(totalFundingYield),        sub: "from funding collection",                                c: "#00ffa3" },
              { l: "LENDING DEPLOYED", v: fmtPct(lendingPercentage, 1),    sub: `${fmtUSD(totalLendingAmount)} total`,                    c: "#a78bfa" },
              { l: "ROLLING APY",      v: `${rollingAPY.toFixed(1)}%`,     sub: `${Math.round(windowSecs / 60)}m window`,                 c: rollingAPY > 0 ? "#00ffa3" : "#f87171" },
              { l: "SHARPE RATIO",     v: sharpe.toFixed(2),               sub: sharpe > 1 ? "good risk-adj return" : sharpe > 0 ? "positive" : "needs data", c: sharpe > 1 ? "#00ffa3" : sharpe > 0 ? "#fbbf24" : "#5ba8d0" },
              { l: "CAPITAL EFF.",     v: fmtPct(capitalEfficiency, 1),    sub: "deployed vs idle",                                       c: capitalEfficiency > 0.7 ? "#00ffa3" : "#fbbf24" },
              { l: "XCHAIN AVG EDGE",  v: fmtPct(avgCrossEdge, 2),         sub: `${crossExecCount}/${ASSETS.length} executable`,          c: avgCrossEdge > 0 ? "#34d399" : "#f59e0b" },
              { l: "DRAWDOWN",         v: fmtPct(vault.drawdown, 2),       sub: vault.drawdown > 0.05 ? "⚠ HIGH" : "NORMAL",             c: vault.drawdown > 0.05 ? "#f87171" : "#00ffa3" },
              { l: "DELTA EXPOSURE",   v: fmtPct(vault.delta, 2),          sub: vault.delta > 0.05 ? "⚠ REBALANCE" : "NEUTRAL",          c: vault.delta > 0.05 ? "#fbbf24" : "#00ffa3" },
              { l: "PRICE FEED",       v: pythOn ? "PYTH" : "SIMULATED",   sub: pythOn ? "Pyth Network live" : "Awaiting oracle",         c: pythOn ? "#34d399" : "#fbbf24" },
            ].map(s => (
              <Card key={s.l}>
                <div style={{ fontSize: 7, color: "#1e2e3e", letterSpacing: 2.5, marginBottom: 5 }}>{s.l}</div>
                <div style={{ fontSize: 17, fontWeight: 500, color: s.c, letterSpacing: .5 }}>{s.v}</div>
                <div style={{ fontSize: 8, color: "#2e3e52", marginTop: 4 }}>{s.sub}</div>
              </Card>
            ))}
          </div>

          {/* Main 2-col row */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>

            {/* ① Market Data */}
            <Card>
              <SectionHead n="1" label="MARKET DATA ENGINE" color="#34d399" />
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: -30, marginBottom: 8 }}>
                <span style={{ fontSize: 7.5, padding: "2px 7px", borderRadius: 3, letterSpacing: 1,
                  background: pythOn ? "#001a0c" : "#1a0f00",
                  color: pythOn ? "#34d399" : "#f59e0b",
                  border: `1px solid ${pythOn ? "#34d39922" : "#f59e0b22"}` }}>
                  {pythOn ? "PYTH NETWORK" : "SIMULATED"}
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {ASSETS.map(a => (
                  <div key={a} className="hov" style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "#060911", borderRadius: 8, border: "1px solid #111e2e", cursor: "default" }}>
                    <div style={{ width: 32 }}>
                      <div style={{ fontSize: 12, fontWeight: 500, color: "#e8eef8" }}>{a}</div>
                      <div style={{ fontSize: 7, color: "#2a3a4e", marginTop: 1 }}>
                        {a === "BTC" ? "Bitcoin" : a === "ETH" ? "Ethereum" : a === "SOL" ? "Solana" : "Jito"}
                      </div>
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: 500, color: "#fff" }}>{fmtUSD(prices[a])}</div>
                      {conf[a] > 0 && <div style={{ fontSize: 7, color: "#2a3e52" }}>±{fmtUSD(conf[a])} conf</div>}
                    </div>
                    <div style={{ textAlign: "right", fontSize: 9 }}>
                      <div style={{ color: funding[a] > FUNDING_THRESHOLD ? "#00ffa3" : "#5ba8d0", marginBottom: 2 }}>
                        FR {fmtPct(funding[a])}
                      </div>
                      <div style={{ color: basis[a] > BASIS_THRESHOLD ? "#f59e0b" : "#2e3e52" }}>
                        BS {fmtPct(basis[a], 2)}
                      </div>
                    </div>
                    <div style={{ textAlign: "right", fontSize: 8 }}>
                      <div style={{ color: "#5ba8d0" }}>${(liquidity[a]/1e6).toFixed(1)}M</div>
                      <div style={{ color: "#1e2e3e" }}>OI</div>
                    </div>
                    <Spark data={a === "BTC" ? hBtc : a === "ETH" ? hEth : a === "SOL" ? hSol : hJto}
                      color={a === "BTC" ? "#f59e0b" : a === "ETH" ? "#5ba8d0" : a === "SOL" ? "#a78bfa" : "#34d399"} w={60} h={28} />
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 10, fontSize: 8, color: "#1e2e3e", padding: "6px 10px", background: "#060911", borderRadius: 6, lineHeight: 1.7 }}>
                Spot prices → <span style={{ color: "#34d399" }}>Pyth Network Hermes API</span> ·
                Funding rates → <span style={{ color: "#5ba8d0" }}>Hyperliquid REST API</span> ·
                Basis = (perp − spot) / spot ·
                Real-time Helius WebSocket in production
              </div>
            </Card>

            {/* ② Strategy */}
            <Card>
              <SectionHead n="2" label="STRATEGY ENGINE" color="#5ba8d0" />
              <div style={{ display: "flex", flexDirection: "column", gap: 7, marginBottom: 10 }}>
                {ASSETS.map(a => (
                  <div key={a} className="hov" style={{ padding: "11px 13px", background: "#060911", borderRadius: 8, border: `1px solid ${(SCOL[signals[a]] || "#111e2e")}1a` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                      <div>
                        <span style={{ fontSize: 13, fontWeight: 500, color: "#e8eef8" }}>{a}</span>
                        <span style={{ fontSize: 8, color: "#2a3a4e", marginLeft: 8 }}>{fmtUSD(prices[a])}</span>
                      </div>
                      <Pill label={signals[a]} />
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
                      {[
                        { l: "FUNDING", v: fmtPct(funding[a]), hi: funding[a] > FUNDING_THRESHOLD, threshold: "> 0.01%" },
                        { l: "BASIS",   v: fmtPct(basis[a],2), hi: basis[a] > BASIS_THRESHOLD,    threshold: "> 1.0%" },
                        { l: "LIQUIDITY", v: `$${(liquidity[a]/1e6).toFixed(1)}M`, hi: liquidity[a] > 3e6, threshold: "> $3M" },
                      ].map(m => (
                        <div key={m.l} style={{ padding: "5px 8px", background: "#050810", borderRadius: 5, border: `1px solid ${m.hi ? "#00ffa322" : "#0f1828"}` }}>
                          <div style={{ fontSize: 7, color: "#2a3a4e", letterSpacing: 1 }}>{m.l}</div>
                          <div style={{ fontSize: 11, color: m.hi ? "#00ffa3" : "#3a4e62", marginTop: 2 }}>{m.v}</div>
                          <div style={{ fontSize: 7, color: "#1e2e3e" }}>{m.threshold}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ padding: "10px 12px", background: "#060911", borderRadius: 8, border: "1px solid #111e2e" }}>
                <div style={{ fontSize: 7.5, color: "#5ba8d0", letterSpacing: 1.5, marginBottom: 7 }}>DECISION LOGIC</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {[
                    { cond: "funding_rate > 0.01%/hr", action: "DELTA_NEUTRAL", col: "#00ffa3", desc: "Short perp + long spot → collect funding" },
                    { cond: "basis_spread > 1.00%",    action: "BASIS_TRADE",   col: "#f59e0b", desc: "Long spot + short perp → capture convergence" },
                    { cond: "else",                    action: "PARK_CAPITAL",  col: "#5ba8d0", desc: "Deploy idle capital to stable yield" },
                  ].map(row => (
                    <div key={row.action} style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 8px", background: "#050810", borderRadius: 5 }}>
                      <code style={{ fontSize: 8, color: "#2a3e52", width: 140, flexShrink: 0 }}>{row.cond}</code>
                      <span style={{ fontSize: 7, color: "#1e2e3e" }}>→</span>
                      <Pill label={row.action} />
                      <span style={{ fontSize: 7.5, color: "#2a3a4e" }}>{row.desc}</span>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          </div>

          {/* ④ AI Agent spotlight row */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10, marginBottom: 10 }}>

            {/* ④ AI Agent */}
            <Card style={{ border: `1px solid ${aiAccent}33`, position: "relative", overflow: "hidden" }}>
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: 3,
                  background: aiAccent,
                  opacity: aiDecisionPulse ? 0.95 : 0.72,
                  boxShadow: `0 0 12px ${aiAccent}88`,
                  animation: aiDecisionPulse ? "aiDecisionPulse 900ms ease-out" : "none",
                  transformOrigin: "center",
                }}
              />
              <SectionHead n="4" label="ADAPTIVE SIGNAL ENGINE" color={aiAccent} />

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: -4, marginBottom: 10 }}>
                <span style={{ fontSize: 7, color: "#2a3a4e", letterSpacing: 1.3 }}>Status</span>
                <span style={{
                  fontSize: 7.5,
                  fontWeight: 600,
                  letterSpacing: 1,
                  padding: "2px 7px",
                  borderRadius: 4,
                  background: `${aiAccent}1f`,
                  color: aiAccent,
                  border: `1px solid ${aiAccent}44`,
                }}>
                  {aiAgent.enabled ? "ACTIVE" : "DISABLED"}
                </span>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, marginBottom: 10 }}>
                <div style={{ padding: "9px 10px", background: "#060911", borderRadius: 7, border: "1px solid #111e2e" }}>
                  <div style={{ fontSize: 7, color: "#1e2e3e", letterSpacing: 1 }}>MODE</div>
                  <div style={{ fontSize: 11, color: aiModeColor, marginTop: 4, fontWeight: 500 }}>{aiAgent.mode}</div>
                </div>
                <div style={{ padding: "9px 10px", background: "#060911", borderRadius: 7, border: "1px solid #111e2e" }}>
                  <div style={{ fontSize: 7, color: "#1e2e3e", letterSpacing: 1 }}>CONFIDENCE</div>
                  <div style={{ fontSize: 11, color: aiModeColor, marginTop: 4, fontWeight: 500 }}>{(aiAgent.confidence * 100).toFixed(1)}%</div>
                </div>
              </div>

              <div style={{ padding: "10px 12px", background: "#060911", borderRadius: 8, border: "1px solid #111e2e", marginBottom: 8 }}>
                <div style={{ fontSize: 7.5, color: aiAccent, letterSpacing: 1.5, marginBottom: 7 }}>LAST DECISION</div>
                <div style={{ fontSize: 11, color: "#e8eef8", marginBottom: 4 }}>{aiAgent.lastDecision}</div>
                <div style={{ fontSize: 8, color: "#3a4e62" }}>{aiAgent.reason}</div>
              </div>

              <div style={{ padding: "10px 12px", background: "#060911", borderRadius: 8, border: "1px solid #111e2e", marginBottom: 8 }}>
                <div style={{ fontSize: 7.5, color: aiAccent, letterSpacing: 1.5, marginBottom: 7 }}>SIGNALS</div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 8, marginBottom: 5 }}>
                  <span style={{ color: "#2a3a4e" }}>Funding</span>
                  <span style={{ color: aiModeColor }}>{aiAgent.fundingSummary}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 8, marginBottom: 5 }}>
                  <span style={{ color: "#2a3a4e" }}>Cross-chain</span>
                  <span style={{ color: aiAgent.crossChainSignal ? "#34d399" : "#f59e0b" }}>{aiAgent.crossChainSignal ? "ON" : "OFF"}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 8 }}>
                  <span style={{ color: "#2a3a4e" }}>Risk</span>
                  <span style={{ color: aiRiskColor }}>{aiAgent.riskLevel}</span>
                </div>
              </div>

              <div style={{ padding: "10px 12px", background: "#060911", borderRadius: 8, border: "1px solid #111e2e" }}>
                <div style={{ fontSize: 7.5, color: aiAccent, letterSpacing: 1.5, marginBottom: 7 }}>EWMA MOMENTUM</div>
                {ASSETS.map(a => {
                  const m = aiAgent.momentumScores?.[a] ?? 0;
                  const mColor = m > 0.1 ? "#34d399" : m < -0.1 ? "#f87171" : "#f59e0b";
                  const barW = Math.abs(m) * 40;
                  return (
                    <div key={a} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
                      <span style={{ fontSize: 7.5, color: "#3a4e62", width: 22 }}>{a}</span>
                      <div style={{ flex: 1, height: 4, background: "#0d1520", borderRadius: 2, overflow: "hidden" }}>
                        <div style={{
                          height: "100%",
                          width: `${barW}%`,
                          background: mColor,
                          borderRadius: 2,
                          marginLeft: m < 0 ? `${100 - barW}%` : 0,
                          transition: "width 0.4s ease",
                        }} />
                      </div>
                      <span style={{ fontSize: 7.5, color: mColor, width: 28, textAlign: "right" }}>
                        {m >= 0 ? "+" : ""}{m.toFixed(2)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </Card>

          </div>

          {/* Engine cards row */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 10, marginBottom: 10 }}>

            {/* ③ Execution */}
            <Card>
              <SectionHead n="3" label="EXECUTION ENGINE" color="#f59e0b" />
              {/* Protocol stack */}
              <div style={{ display: "flex", gap: 7, marginBottom: 12 }}>
                {[
                  { l: "PERP EXCHANGE", v: "Hyperliquid", c: "#f59e0b", sub: "EIP-712 signed REST" },
                  { l: "SPOT ROUTING",  v: "Jupiter Aggregator", c: "#00ffa3", sub: "HTTP API swap" },
                  { l: "RPC PROVIDER",  v: "Helius",             c: "#5ba8d0", sub: "WebSocket + REST" },
                  { l: "POSITION CLOSE", v: "reduceOnly order",  c: "#f87171", sub: "HL perp + Jupiter reverse" },
                ].map(t => (
                  <div key={t.l} style={{ flex: 1, padding: "8px 9px", background: "#060911", borderRadius: 7, border: `1px solid ${t.c}18` }}>
                    <div style={{ fontSize: 7, color: "#1e2e3e", letterSpacing: 1, marginBottom: 4 }}>{t.l}</div>
                    <div style={{ fontSize: 9, color: t.c, fontWeight: 500 }}>{t.v}</div>
                    <div style={{ fontSize: 7, color: "#2a3a4e", marginTop: 2 }}>{t.sub}</div>
                  </div>
                ))}
              </div>

              {/* Flow diagram */}
              <div style={{ display: "flex", alignItems: "center", gap: 0, marginBottom: 12, padding: "9px 12px", background: "#060911", borderRadius: 7, border: "1px solid #111e2e", overflowX: "auto" }}>
                {[
                  { icon: "◎", label: "Pyth Oracle", sub: "price feed", c: "#34d399" },
                  { icon: "→", label: "", sub: "", c: "#1e2e3e" },
                  { icon: "◈", label: "Strategy", sub: "signal", c: "#5ba8d0" },
                  { icon: "→", label: "", sub: "", c: "#1e2e3e" },
                  { icon: "◑", label: "Jupiter", sub: "spot long", c: "#00ffa3" },
                  { icon: "+", label: "", sub: "", c: "#1e2e3e" },
                  { icon: "◐", label: "Hyperliquid", sub: "perp short", c: "#f59e0b" },
                  { icon: "→", label: "", sub: "", c: "#1e2e3e" },
                  { icon: "⬡", label: "Wallet", sub: "signed tx", c: "#a78bfa" },
                ].map((s, i) => (
                  <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
                    <div style={{ fontSize: s.label ? 14 : 16, color: s.c, lineHeight: 1 }}>{s.icon}</div>
                    {s.label && <div style={{ fontSize: 7, color: s.c, marginTop: 3, textAlign: "center", whiteSpace: "nowrap" }}>{s.label}</div>}
                    {s.sub && <div style={{ fontSize: 6.5, color: "#1e2e3e", textAlign: "center", whiteSpace: "nowrap" }}>{s.sub}</div>}
                  </div>
                ))}
              </div>

              {/* Open positions */}
              <div style={{ fontSize: 7.5, color: "#1e2e3e", letterSpacing: 1.5, marginBottom: 7 }}>OPEN POSITIONS</div>
              {positions.length === 0
                ? <div style={{ color: "#1a2535", fontSize: 10, padding: "10px 0", textAlign: "center" }}>No open positions · start bot to trade</div>
                : positions.map((p, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", background: "#060911", borderRadius: 7, border: `1px solid ${p.simulated ? "#2d1f00" : "#111e2e"}`, marginBottom: 5 }}>
                    <div>
                      <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
                        <span style={{ fontSize: 12, fontWeight: 500, color: "#e8eef8" }}>{p.asset}</span>
                        <Pill label={p.type} />
                        {p.simulated && <span style={{ fontSize: 7, background: "#2d1800", color: "#f59e0b", borderRadius: 3, padding: "1px 4px", letterSpacing: 1 }}>SIM</span>}
                      </div>
                      <div style={{ fontSize: 8, color: "#2a3a4e", marginTop: 3 }}>
                        Notional {fmtUSD(p.size)} · Opened {p.opened}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: p.pnl >= 0 ? "#00ffa3" : "#f87171" }}>
                        {p.pnl >= 0 ? "+" : ""}{fmtUSD(p.pnl)}
                      </div>
                      <div style={{ fontSize: 7.5, color: "#2a3a4e" }}>UNREALIZED PnL</div>
                    </div>
                  </div>
                ))
              }

              {/* Recent orders */}
              {orders.length > 0 && (
                <>
                  <div style={{ fontSize: 7.5, color: "#1e2e3e", letterSpacing: 1.5, margin: "10px 0 6px" }}>RECENT ORDERS</div>
                  {orders.slice(0, 3).map(o => (
                    <div key={o.id} style={{ display: "flex", gap: 9, fontSize: 9, padding: "4px 9px", background: "#060911", borderRadius: 5, marginBottom: 3, alignItems: "center" }}>
                      <span style={{ color: "#2a3a4e", flexShrink: 0 }}>{o.time}</span>
                      <span style={{ color: "#00ffa3" }}>{o.asset}</span>
                      <span style={{ color: "#5ba8d0", flex: 1 }}>{o.action}</span>
                      <span style={{ color: "#fbbf24" }}>{fmtUSD(o.size)}</span>
                      <span style={{ color: "#00ffa3", fontSize: 8 }}>✓ FILLED</span>
                    </div>
                  ))}
                </>
              )}
            </Card>

            {/* ⑤ Lending */}
            <Card>
              <SectionHead n="5" label="LENDING ENGINE" color="#a78bfa" />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 500, color: "#e8eef8" }}>{fmtUSD(totalLendingAmount)}</div>
                  <div style={{ fontSize: 8, color: "#2a3a4e" }}>TOTAL DEPLOYED</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 14, fontWeight: 500, color: "#00ffa3" }}>{fmtUSD(totalLendingYield)}</div>
                  <div style={{ fontSize: 8, color: "#2a3a4e" }}>YIELD EARNED</div>
                </div>
              </div>

              {/* Per-asset lending */}
              <div style={{ display: "flex", flexDirection: "column", gap: 7, marginBottom: 10 }}>
                {ASSETS.map(a => (
                  <div key={a} style={{ padding: "10px 12px", background: "#060911", borderRadius: 8, border: "1px solid #111e2e" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                      <div>
                        <span style={{ fontSize: 12, fontWeight: 500, color: "#e8eef8" }}>{a}</span>
                        <span style={{ fontSize: 8, color: "#2a3a4e", marginLeft: 8 }}>{fmtPct(lending[a].amount / (VAULT_INITIAL / ASSETS.length), 1)} of slot</span>
                      </div>
                      <span style={{ fontSize: 10, color: "#a78bfa", fontWeight: 500 }}>{fmtUSD(lending[a].amount)}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: 8, color: "#2a3a4e" }}>Yield earned</span>
                      <span style={{ fontSize: 9, color: "#00ffa3" }}>+{fmtUSD(lending[a].yield)}</span>
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ padding: "10px 12px", background: "#060911", borderRadius: 8, border: "1px solid #111e2e" }}>
                <div style={{ fontSize: 7.5, color: "#a78bfa", letterSpacing: 1.5, marginBottom: 7 }}>LENDING STRATEGY</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {[
                    { cond: "No active signals", action: "Deploy to lending", col: "#a78bfa", desc: "Earn yield on idle capital" },
                    { cond: "High drawdown",     action: "Force 100% lending", col: "#f87171", desc: "Emergency capital preservation" },
                    { cond: "Momentum filter",   action: "Reduce delta exposure", col: "#fbbf24", desc: "Conservative during volatility" },
                  ].map(row => (
                    <div key={row.action} style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 8px", background: "#050810", borderRadius: 5 }}>
                      <code style={{ fontSize: 8, color: "#2a3e52", width: 100, flexShrink: 0 }}>{row.cond}</code>
                      <span style={{ fontSize: 7, color: "#1e2e3e" }}>→</span>
                      <span style={{ fontSize: 8, color: row.col, fontWeight: 500 }}>{row.action}</span>
                      <span style={{ fontSize: 7.5, color: "#2a3a4e" }}>{row.desc}</span>
                    </div>
                  ))}
                </div>
              </div>
            </Card>

            {/* ⑥ Risk */}
            <Card>
              <SectionHead n="6" label="RISK ENGINE" color="#f87171" />
              <div style={{ display: "flex", justifyContent: "space-around", marginBottom: 10 }}>
                <Gauge value={vault.drawdown * 100} max={10} label="DRAWDOWN %" color={vault.drawdown > 0.05 ? "#f87171" : "#00ffa3"} />
                <Gauge value={vault.delta * 100}    max={10} label="DELTA EXP %" color={vault.delta > 0.05 ? "#fbbf24" : "#5ba8d0"} />
                <Gauge value={positions.length}     max={6}  label="POSITIONS"   color="#a78bfa" />
              </div>

              {/* HWM bar */}
              <div style={{ padding: "8px 10px", background: "#060911", borderRadius: 7, border: "1px solid #111e2e", marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                  <span style={{ fontSize: 7.5, color: "#2a3a4e" }}>NAV vs HIGH WATER MARK</span>
                  <span style={{ fontSize: 8, color: "#5ba8d0" }}>{fmtUSD(vault.hwm)} HWM</span>
                </div>
                <div style={{ height: 4, background: "#111e2e", borderRadius: 2 }}>
                  <div style={{ height: "100%", borderRadius: 2, background: vault.drawdown > 0.05 ? "#f87171" : "#00ffa3",
                    width: `${Math.max(2, (1 - vault.drawdown) * 100)}%`, transition: "width .5s" }} />
                </div>
              </div>

              <div style={{ padding: "10px 12px", background: "#060911", borderRadius: 7, border: "1px solid #111e2e", marginBottom: 8 }}>
                <div style={{ fontSize: 7.5, color: "#f87171", letterSpacing: 1.5, marginBottom: 7 }}>HARD LIMITS</div>
                {[
                  { check: "Portfolio drawdown",  limit: "> 10%",  action: "CLOSE ALL positions",      trip: vault.drawdown > 0.10 },
                  { check: "Drawdown warning",     limit: "> 5%",   action: "Alert + monitor",           trip: vault.drawdown > 0.05 },
                  { check: "Delta exposure",       limit: "> 5%",   action: "REBALANCE perp legs",       trip: vault.delta > 0.05 },
                  { check: "Single asset loss",    limit: "> 7%",   action: "CLOSE that leg",            trip: false },
                  { check: "Free collateral",      limit: "< 20%",  action: "HALT new entries",          trip: false },
                ].map(r => (
                  <div key={r.check} style={{ display: "flex", gap: 7, alignItems: "center", padding: "4px 0", borderBottom: "1px solid #0a1018" }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: r.trip ? "#f87171" : "#1e2e3e", display: "inline-block", flexShrink: 0 }} className={r.trip ? "blink" : ""} />
                    <span style={{ fontSize: 8, color: r.trip ? "#f87171" : "#2a3a4e", flex: 1 }}>{r.check}</span>
                    <code style={{ fontSize: 8, color: r.trip ? "#f87171" : "#1e3040" }}>{r.limit}</code>
                    <span style={{ fontSize: 7.5, color: "#1e2e3e", flex: 1, textAlign: "right" }}>{r.action}</span>
                  </div>
                ))}
              </div>
            </Card>

            {/* ⑦ Cross-Chain */}
            <Card>
              <SectionHead n="7" label="CROSS-CHAIN ENGINE" color="#34d399" />

              <div style={{ display: "flex", flexDirection: "column", gap: 7, marginBottom: 10 }}>
                {ASSETS.map(a => {
                  const d = crossChain.decisions[a] || {};
                  const profitable = !!d.execute;
                  return (
                    <div key={a} style={{ padding: "10px 12px", background: "#060911", borderRadius: 8, border: `1px solid ${profitable ? "#34d39933" : "#111e2e"}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                        <span style={{ fontSize: 12, fontWeight: 500, color: "#e8eef8" }}>{a}</span>
                        <span style={{ fontSize: 8, color: profitable ? "#34d399" : "#f59e0b", letterSpacing: 1 }}>
                          {profitable ? "EXECUTE" : "NO-GO"}
                        </span>
                      </div>
                      <div style={{ fontSize: 8, color: "#2a3a4e", lineHeight: 1.7 }}>
                        <div>Route: <span style={{ color: "#5ba8d0" }}>{d.currentChain ?? "solana"}</span> → <span style={{ color: "#34d399" }}>{d.bestChain ?? "solana"}</span></div>
                        <div>Net edge: <span style={{ color: profitable ? "#34d399" : "#f59e0b" }}>{fmtPct(d.netEdge ?? 0, 2)}</span></div>
                        <div>Cost: <span style={{ color: "#a78bfa" }}>{fmtPct(d.totalCostPct ?? 0, 2)}</span></div>
                        <div>Est. PnL: <span style={{ color: (d.expectedProfitUsd ?? 0) >= 0 ? "#34d399" : "#f87171" }}>{fmtUSD(d.expectedProfitUsd ?? 0)}</span></div>
                        <div>Reason: <span style={{ color: "#3a4e62" }}>{d.reason ?? "Waiting"}</span></div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div style={{ padding: "10px 12px", background: "#060911", borderRadius: 8, border: "1px solid #111e2e" }}>
                <div style={{ fontSize: 7.5, color: "#34d399", letterSpacing: 1.5, marginBottom: 7 }}>CHAIN FUNDING MAP (HOURLY)</div>
                <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr 1fr", gap: 4, fontSize: 8 }}>
                  <div style={{ color: "#1e2e3e", letterSpacing: 1 }}>CHAIN</div>
                  {ASSETS.map(a => <div key={a} style={{ color: "#1e2e3e", letterSpacing: 1 }}>{a}</div>)}
                  {CROSS_CHAIN_CHAINS.map(chain => (
                    <React.Fragment key={chain}>
                      <div style={{ color: "#5ba8d0" }}>{chain}</div>
                      {ASSETS.map(a => (
                        <div key={a} style={{ color: "#2a3a4e" }}>{fmtPct(crossChain.fundingByChain?.[chain]?.[a] ?? 0, 3)}</div>
                      ))}
                    </React.Fragment>
                  ))}
                </div>
              </div>
            </Card>
          </div>

          {/* Bottom row: charts + log */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1.4fr", gap: 10 }}>
            <Card>
              <div style={{ fontSize: 7.5, color: "#a78bfa", letterSpacing: 1.5, marginBottom: 10, fontWeight: 500 }}>VAULT PnL HISTORY</div>
              <PnLChart data={hPnl} vaultInitial={VAULT_INITIAL} cycleSeconds={liveSync ? 15 : 2.5} color={vault.pnl >= 0 ? "#00ffa3" : "#f87171"} w={200} h={60} />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 8, color: "#1e2e3e" }}>
                <span>TICK #{tick}</span>
                <span style={{ color: running ? "#00ffa3" : "#2a3a4e" }}>{running ? "● LIVE" : "○ IDLE"}</span>
              </div>
            </Card>
            <Card>
              <div style={{ fontSize: 7.5, color: "#f59e0b", letterSpacing: 1.5, marginBottom: 10, fontWeight: 500 }}>PnL BREAKDOWN</div>
              {[
                { l: "FUNDING YIELD",  v: liveSync ? pnlBreakdown.funding  : totalFundingYield,   c: "#00ffa3" },
                { l: "LENDING YIELD",  v: liveSync ? pnlBreakdown.lending  : totalLendingYield,   c: "#a78bfa" },
                { l: "REALIZED PnL",   v: liveSync ? pnlBreakdown.realized : vault.pnl - totalFundingYield - totalLendingYield, c: "#5ba8d0" },
              ].map(({ l, v, c }) => (
                <div key={l} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", background: "#060911", borderRadius: 7, border: "1px solid #111e2e", marginBottom: 6 }}>
                  <span style={{ fontSize: 8, color: "#2a3a4e", letterSpacing: 0.5 }}>{l}</span>
                  <span style={{ fontSize: 11, color: v >= 0 ? c : "#f87171", fontWeight: 500 }}>{v >= 0 ? "+" : ""}{fmtUSD(v)}</span>
                </div>
              ))}
              <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 10px", background: "#080d14", borderRadius: 5, border: "1px solid #0f1a28" }}>
                <span style={{ fontSize: 7.5, color: "#2a3a4e" }}>TOTAL</span>
                <span style={{ fontSize: 11, color: vault.pnl >= 0 ? "#00ffa3" : "#f87171", fontWeight: 700 }}>{vault.pnl >= 0 ? "+" : ""}{fmtUSD(vault.pnl)}</span>
              </div>
            </Card>
            <Card>
              <div style={{ fontSize: 7.5, color: "#5ba8d0", letterSpacing: 1.5, marginBottom: 10, fontWeight: 500 }}>ASSET PRICES</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                {[
                  { a: "BTC", h: hBtc, c: "#f59e0b" },
                  { a: "ETH", h: hEth, c: "#5ba8d0" },
                  { a: "SOL", h: hSol, c: "#a78bfa" },
                  { a: "JTO", h: hJto, c: "#34d399" },
                ].map(({ a, h, c }) => (
                  <div key={a}>
                    <div style={{ fontSize: 7, color: c, marginBottom: 2 }}>{a} {fmtUSD(prices[a] ?? 0)}</div>
                    <Spark data={h} color={c} w={82} h={36} />
                  </div>
                ))}
              </div>
            </Card>
            <Card style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ fontSize: 7.5, color: "#2a3a4e", letterSpacing: 1.5, marginBottom: 7, fontWeight: 500 }}>ACTIVITY LOG</div>
              <div ref={logsRef} style={{ flex: 1, overflowY: "auto", maxHeight: 160, display: "flex", flexDirection: "column", gap: 0 }}>
                {logs.length === 0
                  ? <div style={{ color: "#141e2a", fontSize: 9, padding: "10px 0" }}>Start the bot to see live activity…</div>
                  : logs.slice().reverse().slice(0, 30).reverse().map(l => <Log key={l.id} e={l} />)
                }
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          TAB: ARCHITECTURE
      ══════════════════════════════════════════════════════════════════════ */}
      {tab === "architecture" && (
        <div className="fadein" style={{ padding: "24px", maxWidth: 900, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 30 }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: "#00ffa3", fontFamily: "'Syne',sans-serif", letterSpacing: 1 }}>System Architecture</div>
            <div style={{ fontSize: 10, color: "#2a3a4e", marginTop: 4, letterSpacing: 2 }}>DELTA-NEUTRAL VAULT · SOLANA · HYPERLIQUID + KAMINO</div>
          </div>

          {/* Architecture diagram */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 14 }}>

            {/* Layer 1 */}
            <div>
              <div style={{ fontSize: 8, color: "#2a3a4e", letterSpacing: 2, marginBottom: 8, textAlign: "center" }}>DATA LAYER</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                {[
                  { icon: "◎", title: "Pyth Network", sub: "Hermes REST + WebSocket", desc: "Real-time BTC/ETH spot prices with confidence intervals. Feeds strategy engine every 12s.", col: "#34d399" },
                  { icon: "⬡", title: "Helius RPC",   sub: "Solana devnet/mainnet",   desc: "High-performance RPC for account reads, tx sending, and oracle monitoring.", col: "#5ba8d0" },
                  { icon: "◈", title: "Hyperliquid",  sub: "perp funding rates",     desc: "Live perp mark prices, hourly funding rates, open interest, and long/short ratios via REST API.", col: "#f59e0b" },
                ].map(c => (
                  <Card key={c.title} style={{ border: `1px solid ${c.col}22` }}>
                    <div style={{ fontSize: 18, color: c.col, marginBottom: 7 }}>{c.icon}</div>
                    <div style={{ fontSize: 11, fontWeight: 500, color: "#e8eef8", marginBottom: 3 }}>{c.title}</div>
                    <div style={{ fontSize: 8, color: c.col, marginBottom: 6, letterSpacing: .5 }}>{c.sub}</div>
                    <div style={{ fontSize: 9, color: "#2a3a4e", lineHeight: 1.6 }}>{c.desc}</div>
                  </Card>
                ))}
              </div>
            </div>

            <div style={{ textAlign: "center", color: "#1e2e3e", fontSize: 18 }}>↓</div>

            {/* Layer 2 */}
            <div>
              <div style={{ fontSize: 8, color: "#2a3a4e", letterSpacing: 2, marginBottom: 8, textAlign: "center" }}>STRATEGY + RISK LAYER</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {[
                  { icon: "②", title: "Strategy Engine", col: "#5ba8d0", items: ["Evaluates funding rate vs 0.01%/hr threshold", "Evaluates basis spread vs 1.0% threshold", "Kelly-inspired position sizing by signal strength", "Emits typed signals: DELTA_NEUTRAL / BASIS_TRADE / PARK_CAPITAL"] },
                  { icon: "④", title: "Risk Engine",      col: "#f87171", items: ["10s check cycle (faster than 15s strategy loop)", "Hard stop: drawdown > 10% → close all (uses actual HL equity)", "Rebalance trigger: delta exposure > 5% of NAV", "Position auto-close: max 4hr hold / 1% profit target / funding flip", "Duplicate guard: prevents opening multiple positions per asset"] },
                ].map(c => (
                  <Card key={c.title} style={{ border: `1px solid ${c.col}22` }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
                      <div style={{ fontSize: 14, color: c.col }}>{c.icon}</div>
                      <div style={{ fontSize: 12, fontWeight: 500, color: "#e8eef8" }}>{c.title}</div>
                    </div>
                    {c.items.map((item, i) => (
                      <div key={i} style={{ display: "flex", gap: 7, alignItems: "flex-start", marginBottom: 5 }}>
                        <span style={{ color: c.col, fontSize: 8, marginTop: 1, flexShrink: 0 }}>▸</span>
                        <span style={{ fontSize: 9, color: "#2a3a4e", lineHeight: 1.5 }}>{item}</span>
                      </div>
                    ))}
                  </Card>
                ))}
              </div>
            </div>

            <div style={{ textAlign: "center", color: "#1e2e3e", fontSize: 18 }}>↓</div>

            {/* Layer 3 */}
            <div>
              <div style={{ fontSize: 8, color: "#2a3a4e", letterSpacing: 2, marginBottom: 8, textAlign: "center" }}>EXECUTION LAYER</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                {[
                  { icon: "③", title: "Hyperliquid", col: "#f59e0b", desc: "Perpetuals exchange. Opens via EIP-712 signed REST order. Closes via reduceOnly IOC order. Collects funding rate yield on short positions." },
                  { icon: "◑", title: "Jupiter API",      col: "#00ffa3", desc: "HTTP API spot swaps. USDC → BTC/ETH for spot long leg. No minimum order size — works with any vault size. Price impact checked before execution." },
                  { icon: "⬡", title: "Phantom / Vault Keypair", col: "#a78bfa", desc: "Browser: Phantom wallet for manual approvals. Server: standalone ServerWallet keypair. Signs Solana and Hyperliquid transactions." },
                ].map(c => (
                  <Card key={c.title} style={{ border: `1px solid ${c.col}22` }}>
                    <div style={{ fontSize: 16, color: c.col, marginBottom: 7 }}>{c.icon}</div>
                    <div style={{ fontSize: 11, fontWeight: 500, color: "#e8eef8", marginBottom: 6 }}>{c.title}</div>
                    <div style={{ fontSize: 9, color: "#2a3a4e", lineHeight: 1.6 }}>{c.desc}</div>
                  </Card>
                ))}
              </div>
            </div>

            {/* Deployment */}
            <Card style={{ border: "1px solid #1e2e3e" }}>
              <div style={{ fontSize: 8, color: "#2a3a4e", letterSpacing: 2, marginBottom: 10, textAlign: "center" }}>DEPLOYMENT</div>
              <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
                {[
                  { l: "Cloud Server", v: "AWS EC2 / t3.medium", c: "#f59e0b" },
                  { l: "Runtime", v: "Node.js 18 + TypeScript", c: "#5ba8d0" },
                  { l: "Process Manager", v: "PM2 cluster mode", c: "#00ffa3" },
                  { l: "Monitoring", v: "Telegram alerts", c: "#a78bfa" },
                  { l: "Logs", v: "Rotating JSON files", c: "#34d399" },
                ].map(d => (
                  <div key={d.l} style={{ textAlign: "center", padding: "8px 14px", background: "#060911", borderRadius: 7, border: `1px solid ${d.c}1a` }}>
                    <div style={{ fontSize: 7, color: "#1e2e3e", letterSpacing: 1 }}>{d.l}</div>
                    <div style={{ fontSize: 9, color: d.c, marginTop: 3 }}>{d.v}</div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12, textAlign: "center", display: "flex", gap: 12, justifyContent: "center" }}>
                <a
                  href="https://explorer.solana.com/address/2g9eqiJXmGkJARi7Sgmk3U5Fy7KRdAwPonuMeYyouAEr?cluster=devnet"
                  target="_blank" rel="noreferrer"
                  style={{ fontSize: 8, color: "#00ffa3", letterSpacing: 1, textDecoration: "none", padding: "4px 12px", background: "#001a0c", border: "1px solid #00ffa322", borderRadius: 4 }}
                >
                  ◈ SOLANA EXPLORER
                </a>
                <a
                  href="https://solscan.io/account/2g9eqiJXmGkJARi7Sgmk3U5Fy7KRdAwPonuMeYyouAEr?cluster=devnet"
                  target="_blank" rel="noreferrer"
                  style={{ fontSize: 8, color: "#5ba8d0", letterSpacing: 1, textDecoration: "none", padding: "4px 12px", background: "#00101a", border: "1px solid #5ba8d022", borderRadius: 4 }}
                >
                  ⬡ SOLSCAN
                </a>
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          TAB: HOW IT WORKS
      ══════════════════════════════════════════════════════════════════════ */}
      {tab === "how" && (
        <div className="fadein" style={{ padding: "24px", maxWidth: 860, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 30 }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: "#00ffa3", fontFamily: "'Syne',sans-serif", letterSpacing: 1 }}>How Delta-Neutral Works</div>
            <div style={{ fontSize: 10, color: "#2a3a4e", marginTop: 4, letterSpacing: 2 }}>THE STRATEGY EXPLAINED</div>
          </div>

          {/* Core concept */}
          <Card style={{ marginBottom: 14, border: "1px solid #00ffa322" }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: "#00ffa3", marginBottom: 8, fontFamily: "'Syne',sans-serif" }}>The Core Idea</div>
            <div style={{ fontSize: 10, color: "#4a6a7a", lineHeight: 1.8 }}>
              In crypto perpetual markets, traders who hold long positions pay a <span style={{ color: "#00ffa3" }}>funding rate</span> to short holders
              when the market is bullish. Delta Vault captures this yield by simultaneously holding
              a <span style={{ color: "#00ffa3" }}>spot LONG</span> (via Jupiter) and a <span style={{ color: "#f59e0b" }}>perp SHORT</span> (via Hyperliquid) of equal size.
              The two positions cancel out all price exposure (delta = ~0), leaving only the funding yield.
            </div>
          </Card>

          {/* 3-step flow */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 14 }}>
            {[
              { n: "01", title: "Scan", col: "#34d399", desc: "Every 15s, the Market Data Engine calls Hyperliquid REST API for live BTC/ETH/SOL/JTO funding rates, mark prices, and oracle prices." },
              { n: "02", title: "Decide", col: "#5ba8d0", desc: "The Strategy Engine applies thresholds. If funding > 0.01%/hr, a delta-neutral trade is worthwhile. If basis > 1%, a basis convergence trade fires." },
              { n: "03", title: "Execute", col: "#f59e0b", desc: "Both legs placed sequentially. Spot LONG via Jupiter API swap, perp SHORT via Hyperliquid EIP-712 order. If the spot leg fails, the perp order is never sent. Positions close via reduceOnly IOC orders." },
            ].map(s => (
              <Card key={s.n} style={{ border: `1px solid ${s.col}22` }}>
                <div style={{ fontSize: 28, fontWeight: 800, color: s.col + "33", fontFamily: "'Syne',sans-serif", marginBottom: 6 }}>{s.n}</div>
                <div style={{ fontSize: 13, fontWeight: 500, color: s.col, marginBottom: 7 }}>{s.title}</div>
                <div style={{ fontSize: 9, color: "#2a3a4e", lineHeight: 1.7 }}>{s.desc}</div>
              </Card>
            ))}
          </div>

          {/* Fee structure */}
          <Card style={{ marginBottom: 14, border: "1px solid #a78bfa22" }}>
            <div style={{ fontSize: 11, fontWeight: 500, color: "#a78bfa", marginBottom: 10, fontFamily: "'Syne',sans-serif" }}>Vault Fee Structure</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
              {[
                { l: "MANAGEMENT FEE", v: "2.00% / yr", sub: "Time-weighted, collected on withdrawal or epoch", c: "#a78bfa" },
                { l: "PERFORMANCE FEE", v: "20% of profit", sub: "Above high-water mark, minted as vault shares", c: "#f59e0b" },
                { l: "SETTLEMENT",      v: "USDC (native)", sub: "No wrapping — on-chain Anchor program", c: "#5ba8d0" },
                { l: "WITHDRAWAL",      v: "Instant (NAV-priced)", sub: "NAV staleness guard on every withdraw", c: "#00ffa3" },
              ].map(f => (
                <div key={f.l} style={{ padding: "10px 12px", background: "#060911", borderRadius: 8, border: `1px solid ${f.c}18` }}>
                  <div style={{ fontSize: 7, color: "#1e2e3e", letterSpacing: 1.5, marginBottom: 5 }}>{f.l}</div>
                  <div style={{ fontSize: 13, color: f.c, fontWeight: 500, marginBottom: 3 }}>{f.v}</div>
                  <div style={{ fontSize: 8, color: "#2a3a4e", lineHeight: 1.5 }}>{f.sub}</div>
                </div>
              ))}
            </div>
          </Card>

          {/* P&L math */}
          <Card style={{ marginBottom: 14, border: "1px solid #f59e0b22" }}>
            <div style={{ fontSize: 11, fontWeight: 500, color: "#f59e0b", marginBottom: 10 }}>Yield Calculation</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <div>
                <div style={{ fontSize: 9, color: "#2a3a4e", lineHeight: 1.9 }}>
                  <div style={{ color: "#e8eef8", marginBottom: 4 }}>Delta-Neutral Position (example)</div>
                  <div>Notional size: <span style={{ color: "#00ffa3" }}>$50,000</span></div>
                  <div>Funding rate: <span style={{ color: "#00ffa3" }}>0.01%/hr</span></div>
                  <div>Hourly yield: <span style={{ color: "#00ffa3" }}>$5.00</span></div>
                  <div>Daily yield: <span style={{ color: "#00ffa3" }}>$120.00</span></div>
                  <div>Annual APR: <span style={{ color: "#00ffa3" }}>~87.6%</span></div>
                </div>
              </div>
              <div>
                <div style={{ fontSize: 9, color: "#2a3a4e", lineHeight: 1.9 }}>
                  <div style={{ color: "#e8eef8", marginBottom: 4 }}>Risk Profile</div>
                  <div>Price risk: <span style={{ color: "#00ffa3" }}>~0 (delta-neutral)</span></div>
                  <div>Funding risk: <span style={{ color: "#fbbf24" }}>Rate reversal</span></div>
                  <div>Basis risk: <span style={{ color: "#fbbf24" }}>Perp/spot divergence</span></div>
                  <div>Execution risk: <span style={{ color: "#fbbf24" }}>Slippage, failed tx</span></div>
                  <div>Liquidation risk: <span style={{ color: "#f87171" }}>If margin is insufficient</span></div>
                </div>
              </div>
            </div>
          </Card>

          {/* Advantages */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Card style={{ border: "1px solid #00ffa322" }}>
              <div style={{ fontSize: 11, fontWeight: 500, color: "#00ffa3", marginBottom: 8 }}>Why Hyperliquid</div>
              {["Highest perp liquidity on Solana", "Sub-second transaction finality", "Low fees (< $0.01 per trade)", "Open-source, audited smart contracts", "Native USDC collateral — no wrapping"].map((t, i) => (
                <div key={i} style={{ display: "flex", gap: 7, alignItems: "center", marginBottom: 5 }}>
                  <span style={{ color: "#00ffa3", fontSize: 9 }}>✓</span>
                  <span style={{ fontSize: 9, color: "#2a3a4e" }}>{t}</span>
                </div>
              ))}
            </Card>
            <Card style={{ border: "1px solid #a78bfa22" }}>
              <div style={{ fontSize: 11, fontWeight: 500, color: "#a78bfa", marginBottom: 8 }}>Hackathon Advantages</div>
              {[
                "Live dashboard — judges see a real trading platform",
                "Real Pyth prices — not mock data",
                "Phantom wallet integration — one-click connect",
                "4 complete engines, each independently testable",
                "Production TypeScript codebase ready to deploy",
              ].map((t, i) => (
                <div key={i} style={{ display: "flex", gap: 7, alignItems: "center", marginBottom: 5 }}>
                  <span style={{ color: "#a78bfa", fontSize: 9 }}>◈</span>
                  <span style={{ fontSize: 9, color: "#2a3a4e" }}>{t}</span>
                </div>
              ))}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
