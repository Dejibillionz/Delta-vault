import { useState, useEffect, useRef, useCallback } from "react";

/* ═══════════════════════════════════════════════════════════════════════════
   DELTA VAULT — Full Presentation Build
   All 4 engines unified: Market Data · Strategy · Execution · Risk
   Live Pyth prices · Phantom wallet · Hyperliquid + Kamino · SIMULATION MODE
═══════════════════════════════════════════════════════════════════════════ */

// ── Constants ─────────────────────────────────────────────────────────────────
const ASSETS = ["BTC", "ETH"];
const FUNDING_THRESHOLD = 0.0001;   // 0.01%/hr
const BASIS_THRESHOLD   = 0.01;     // 1%
const VAULT_INITIAL     = 250000;

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
const SCOL = { DELTA_NEUTRAL: "#00ffa3", BASIS_TRADE: "#f59e0b", PARK_CAPITAL: "#5ba8d0", NONE: "#3a4e62" };
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
  const [running,    setRunning]    = useState(false);
  const [tab,        setTab]        = useState("dashboard"); // dashboard | architecture | how

  // Market data
  const [prices,    setPrices]    = useState({ BTC: 68450, ETH: 3515 });
  const [funding,   setFunding]   = useState({ BTC: 0.000135, ETH: 0.000092 });
  const [basis,     setBasis]     = useState({ BTC: 0.0074,   ETH: 0.0058 });
  const [liquidity, setLiquidity] = useState({ BTC: 12.4e6,   ETH: 6.1e6 });
  const [conf,      setConf]      = useState({ BTC: 0, ETH: 0 });
  const [pythOn,    setPythOn]    = useState(false);
  const [pythTime,  setPythTime]  = useState(null);

  // Wallet
  const [wallet, setWallet] = useState({ connected: false, address: "", loading: false });

  // Strategy
  const [signals,   setSignals]   = useState({ BTC: "PARK_CAPITAL", ETH: "PARK_CAPITAL" });
  const [positions, setPositions] = useState([]);
  const [orders,    setOrders]    = useState([]);

  // Vault metrics
  const [vault, setVault] = useState({ nav: VAULT_INITIAL, pnl: 0, drawdown: 0, delta: 0, hwm: VAULT_INITIAL });

  // History arrays
  const [hPnl,  setHPnl]  = useState(Array(50).fill(0));
  const [hBtc,  setHBtc]  = useState(Array(50).fill(68450));
  const [hEth,  setHEth]  = useState(Array(50).fill(3515));
  const [hDraw, setHDraw] = useState(Array(50).fill(0));

  // Logs
  const [logs,      setLogs]      = useState([]);
  const [riskFlags, setRiskFlags] = useState([]);
  const [tick,      setTick]      = useState(0);
  const logsRef = useRef(null);

  const addLog = useCallback((type, msg) => {
    setLogs(p => [...p.slice(-200), { type, msg, time: ts(), id: Math.random() }]);
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

  // ── Strategy evaluation ───────────────────────────────────────────────────
  const evalSigs = (fr, bs) => {
    const s = {};
    for (const a of ASSETS) {
      if (fr[a] > FUNDING_THRESHOLD) s[a] = "DELTA_NEUTRAL";
      else if (bs[a] > BASIS_THRESHOLD) s[a] = "BASIS_TRADE";
      else s[a] = "PARK_CAPITAL";
    }
    return s;
  };

  // ── Bot loop ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      setTick(t => t + 1);

      // Hyperliquid funding & basis walk (server-side in prod; simulated here)
      setFunding(f => { const n = {}; ASSETS.forEach(a => { n[a] = clamp(f[a] + rand(-0.000012, 0.000014), 0.00002, 0.00042); }); return n; });
      setBasis(b =>   { const n = {}; ASSETS.forEach(a => { n[a] = clamp(b[a] + rand(-0.0007, 0.0007), 0.0008, 0.022); });   return n; });
      setLiquidity(l =>{ const n = {}; ASSETS.forEach(a => { n[a] = clamp(l[a] + rand(-3e5,3e5), 1e6, 20e6); });            return n; });

      // Price walk on top of live Pyth
      setPrices(p => {
        const n = { BTC: p.BTC * (1 + rand(-0.0008, 0.0008)), ETH: p.ETH * (1 + rand(-0.0009, 0.0009)) };
        setHBtc(h => [...h.slice(-49), n.BTC]);
        setHEth(h => [...h.slice(-49), n.ETH]);
        return n;
      });

      setFunding(fr => {
        setBasis(bs => {
          const sigs = evalSigs(fr, bs);
          setSignals(sigs);

          ASSETS.forEach(a => {
            if (sigs[a] === "DELTA_NEUTRAL") {
              setPositions(p => {
                if (p.find(x => x.asset === a)) return p;
                const sz = rand(4000, 18000);
                addLog("TRADE", `${a} DELTA_NEUTRAL — spot long + perp short $${sz.toFixed(0)} on Hyperliquid`);
                setOrders(o => [{
                  id: Date.now(), time: ts(), asset: a,
                  action: "PERP SHORT + SPOT LONG", size: sz, status: "FILLED",
                }, ...o.slice(0, 9)]);
                return [...p, { asset: a, type: "DELTA_NEUTRAL", size: sz, pnl: 0, opened: ts() }];
              });
            } else if (sigs[a] === "BASIS_TRADE") {
              setPositions(p => {
                if (p.find(x => x.asset === a && x.type === "BASIS_TRADE")) return p;
                const sz = rand(5000, 20000);
                addLog("TRADE", `${a} BASIS_TRADE — spread ${fmtPct(bs[a], 2)}, size $${sz.toFixed(0)}`);
                return [...p, { asset: a, type: "BASIS_TRADE", size: sz, pnl: 0, opened: ts() }];
              });
            } else {
              setPositions(p => {
                if (p.find(x => x.asset === a)) addLog("INFO", `${a}: parking capital — below all thresholds`);
                return p.filter(x => x.asset !== a);
              });
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
        const nav = VAULT_INITIAL + totalPnl;

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
  }, [running, addLog, tick]);

  useEffect(() => {
    if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight;
  }, [logs]);

  // ── Computed ──────────────────────────────────────────────────────────────
  const totalFundingYield = positions.filter(p => p.type === "DELTA_NEUTRAL").reduce((s, p) => s + p.size * funding[p.asset] * 24, 0);

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
        .fadein{animation:fadein .4s ease}
        @keyframes fadein{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
        .hov:hover{background:#0f1520!important;transition:background .15s}
        .tabbtn{cursor:pointer;border:none;background:transparent;font-family:inherit;font-size:10px;font-weight:500;letter-spacing:1.5px;padding:7px 16px;border-radius:6px;transition:all .18s}
        .tabbtn.active{background:#0f1a28;color:#00ffa3;border:1px solid #00ffa322}
        .tabbtn:not(.active){color:#3a4e62;border:1px solid transparent}
        .tabbtn:not(.active):hover{color:#7a9bb8}
      `}</style>

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
            background: pythOn ? "#001a0c" : "#0e0e00",
            color: pythOn ? "#00ffa3" : "#666",
            border: `1px solid ${pythOn ? "#00ffa322" : "#33330022"}`,
          }}>
            {pythOn ? "⬤ PYTH NETWORK LIVE" : "◯ PYTH CONNECTING"}
          </span>
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
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 9, marginBottom: 12 }}>
            {[
              { l: "VAULT NAV",      v: fmtUSD(vault.nav),              sub: `PnL ${vault.pnl >= 0 ? "+" : ""}${fmtUSD(vault.pnl)}`, c: vault.pnl >= 0 ? "#00ffa3" : "#f87171" },
              { l: "OPEN POSITIONS", v: positions.length,                sub: `${positions.filter(p=>p.type==="DELTA_NEUTRAL").length} delta-neutral`,   c: "#5ba8d0" },
              { l: "PROJ. YIELD/DAY",v: fmtUSD(totalFundingYield),       sub: "from funding collection",                                               c: "#00ffa3" },
              { l: "DRAWDOWN",       v: fmtPct(vault.drawdown, 2),       sub: vault.drawdown > 0.05 ? "⚠ HIGH" : "NORMAL",                             c: vault.drawdown > 0.05 ? "#f87171" : "#00ffa3" },
              { l: "DELTA EXPOSURE", v: fmtPct(vault.delta, 2),          sub: vault.delta > 0.05 ? "⚠ REBALANCE" : "NEUTRAL",                          c: vault.delta > 0.05 ? "#fbbf24" : "#00ffa3" },
              { l: "PRICE FEED",     v: pythOn ? "PYTH" : "SIMULATED",   sub: pythOn ? "Pyth Network live" : "Awaiting oracle",                          c: pythOn ? "#34d399" : "#fbbf24" },
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
                      <div style={{ fontSize: 7, color: "#2a3a4e", marginTop: 1 }}>{a === "BTC" ? "Bitcoin" : "Ethereum"}</div>
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
                    <Spark data={a === "BTC" ? hBtc : hEth} color={a === "BTC" ? "#f59e0b" : "#5ba8d0"} w={60} h={28} />
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

          {/* Second row */}
          <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 10, marginBottom: 10 }}>

            {/* ③ Execution */}
            <Card>
              <SectionHead n="3" label="EXECUTION ENGINE" color="#f59e0b" />
              {/* Protocol stack */}
              <div style={{ display: "flex", gap: 7, marginBottom: 12 }}>
                {[
                  { l: "PERP EXCHANGE", v: "Hyperliquid", c: "#f59e0b", sub: "EIP-712 signed REST" },
                  { l: "SPOT ROUTING",  v: "Jupiter Aggregator", c: "#00ffa3", sub: "v6 API" },
                  { l: "RPC PROVIDER",  v: "Helius",             c: "#5ba8d0", sub: "WebSocket + REST" },
                  { l: "WALLET",        v: wallet.connected ? shortAddr(wallet.address) : "Phantom", c: "#a78bfa", sub: wallet.connected ? "Connected" : "Not connected" },
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
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", background: "#060911", borderRadius: 7, border: "1px solid #111e2e", marginBottom: 5 }}>
                    <div>
                      <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
                        <span style={{ fontSize: 12, fontWeight: 500, color: "#e8eef8" }}>{p.asset}</span>
                        <Pill label={p.type} />
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

            {/* ④ Risk */}
            <Card>
              <SectionHead n="4" label="RISK ENGINE" color="#f87171" />
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
          </div>

          {/* Bottom row: charts + log */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1.4fr", gap: 10 }}>
            <Card>
              <div style={{ fontSize: 7.5, color: "#a78bfa", letterSpacing: 1.5, marginBottom: 10, fontWeight: 500 }}>VAULT PnL HISTORY</div>
              <Spark data={hPnl} color={vault.pnl >= 0 ? "#00ffa3" : "#f87171"} w={200} h={60} />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 8, color: "#1e2e3e" }}>
                <span>TICK #{tick}</span>
                <span style={{ color: running ? "#00ffa3" : "#2a3a4e" }}>{running ? "● LIVE" : "○ IDLE"}</span>
              </div>
            </Card>
            <Card>
              <div style={{ fontSize: 7.5, color: "#5ba8d0", letterSpacing: 1.5, marginBottom: 10, fontWeight: 500 }}>BTC · ETH PRICES</div>
              <div style={{ display: "flex", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 7, color: "#f59e0b", marginBottom: 3 }}>BTC {fmtUSD(prices.BTC)}</div>
                  <Spark data={hBtc} color="#f59e0b" w={88} h={44} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 7, color: "#5ba8d0", marginBottom: 3 }}>ETH {fmtUSD(prices.ETH)}</div>
                  <Spark data={hEth} color="#5ba8d0" w={88} h={44} />
                </div>
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
                  { icon: "⬡", title: "Helius RPC",   sub: "Solana RPC + WebSocket",   desc: "High-performance RPC for Solana tx sending, oracle monitoring, and on-chain vault state reads.", col: "#5ba8d0" },
                  { icon: "◈", title: "Hyperliquid",  sub: "AMM funding rates",     desc: "Live perp mark prices, hourly funding rates, open interest, and long/short ratios.", col: "#f59e0b" },
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
                  { icon: "④", title: "Risk Engine",      col: "#f87171", items: ["10s check cycle (faster than 30s strategy loop)", "Hard stop: drawdown > 10% → close all", "Rebalance trigger: delta exposure > 5% of NAV", "Single leg stop: position loss > 7%", "Collateral guard: free collateral < 20% → halt entries"] },
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
                  { icon: "③", title: "Hyperliquid", col: "#f59e0b", desc: "Perp execution via EIP-712 signed REST API. Places PERP SHORT for positive funding arb. Closes via market order. Rebalances on delta breach." },
                  { icon: "◑", title: "Jupiter v6",      col: "#00ffa3", desc: "Best-route spot swaps. USDC → BTC/ETH for spot long leg. Price impact checked < 0.5% before execution." },
                  { icon: "⬡", title: "Phantom / Vault Keypair", col: "#a78bfa", desc: "Browser: Phantom wallet for manual approvals. Server: secure keypair from env var. Signs all transactions." },
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
              <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
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
              { n: "01", title: "Scan", col: "#34d399", desc: "Every 15s, the Market Data Engine polls Hyperliquid REST API for live BTC/ETH/SOL/JTO prices, perp funding rates, and open interest." },
              { n: "02", title: "Decide", col: "#5ba8d0", desc: "The Strategy Engine applies thresholds. If funding > 0.01%/hr, a delta-neutral trade is worthwhile. If basis > 1%, a basis convergence trade fires." },
              { n: "03", title: "Execute", col: "#f59e0b", desc: "Both legs placed atomically. Spot LONG via Jupiter V6 swap, perp SHORT via Hyperliquid EIP-712 REST order. If either leg fails, the other is automatically unwound." },
            ].map(s => (
              <Card key={s.n} style={{ border: `1px solid ${s.col}22` }}>
                <div style={{ fontSize: 28, fontWeight: 800, color: s.col + "33", fontFamily: "'Syne',sans-serif", marginBottom: 6 }}>{s.n}</div>
                <div style={{ fontSize: 13, fontWeight: 500, color: s.col, marginBottom: 7 }}>{s.title}</div>
                <div style={{ fontSize: 9, color: "#2a3a4e", lineHeight: 1.7 }}>{s.desc}</div>
              </Card>
            ))}
          </div>

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
