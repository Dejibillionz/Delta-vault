import { useState, useEffect, useRef, useCallback } from "react";

const ASSETS = ["BTC", "ETH"];
const FUNDING_THRESHOLD = 0.0001;
const BASIS_THRESHOLD = 0.01;
const PYTH_HERMES = "https://hermes.pyth.network/v2/updates/price/latest";
const PYTH_IDS = {
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const fmtUSD = n => "$" + (n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (n, d = 4) => ((n || 0) * 100).toFixed(d) + "%";
const short = s => s ? s.slice(0, 5) + "..." + s.slice(-4) : "";

async function fetchPythPrices() {
  try {
    const ids = Object.values(PYTH_IDS).map(id => `ids[]=${id}`).join("&");
    const res = await fetch(`${PYTH_HERMES}?${ids}`);
    const data = await res.json();
    const prices = {};
    for (const item of (data.parsed ?? [])) {
      const asset = Object.entries(PYTH_IDS).find(([, id]) => id === item.id)?.[0];
      if (!asset) continue;
      const exp = item.price.expo;
      prices[asset] = {
        price: item.price.price * Math.pow(10, exp),
        confidence: item.price.conf * Math.pow(10, exp),
      };
    }
    return prices;
  } catch { return null; }
}

function Spark({ data, color = "#00ffa3", height = 36, width = 100 }) {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data), range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const areaPath = `M 0,${height} L ${pts.split(" ").map(p => p).join(" L ")} L ${width},${height} Z`;
  return (
    <svg width={width} height={height} style={{ overflow: "visible" }}>
      <defs>
        <linearGradient id={`sg${color.slice(1)}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.2" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#sg${color.slice(1)})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function Gauge({ value, max, label, color }) {
  const pct = clamp(value / max, 0, 1);
  const r = 34, cx = 46, cy = 48;
  const toXY = deg => ({ x: cx + r * Math.cos(deg * Math.PI / 180), y: cy + r * Math.sin(deg * Math.PI / 180) });
  const s = toXY(-135), e = toXY(-135 + pct * 270);
  const arc = `M ${s.x} ${s.y} A ${r} ${r} 0 ${pct > 0.5 ? 1 : 0} 1 ${e.x} ${e.y}`;
  const track = `M ${toXY(-135).x} ${toXY(-135).y} A ${r} ${r} 0 1 1 ${toXY(135).x} ${toXY(135).y}`;
  return (
    <div style={{ textAlign: "center" }}>
      <svg width={92} height={62}>
        <path d={track} fill="none" stroke="#141e2c" strokeWidth={5} strokeLinecap="round" />
        {pct > 0.002 && <path d={arc} fill="none" stroke={color} strokeWidth={5} strokeLinecap="round" />}
        <text x={cx} y={cy + 2} textAnchor="middle" fill="#fff" fontSize={11} fontWeight="700" fontFamily="monospace">
          {(pct * 100).toFixed(0)}%
        </text>
      </svg>
      <div style={{ fontSize: 8, color: "#445", marginTop: -5, fontFamily: "monospace", letterSpacing: 1 }}>{label}</div>
    </div>
  );
}

const LOG_COLORS = { INFO: "#7dd3fc", TRADE: "#00ffa3", RISK: "#f87171", WARN: "#fbbf24", SYS: "#a78bfa" };
function LogLine({ e }) {
  return (
    <div style={{ display: "flex", gap: 7, fontSize: 10, fontFamily: "monospace", lineHeight: 1.65 }}>
      <span style={{ color: "#3a4a5a", flexShrink: 0 }}>{e.time}</span>
      <span style={{ color: LOG_COLORS[e.type] || "#888", width: 42, flexShrink: 0 }}>[{e.type}]</span>
      <span style={{ color: "#bbb" }}>{e.msg}</span>
    </div>
  );
}

const SIG_COLOR = { DELTA_NEUTRAL: "#00ffa3", BASIS_TRADE: "#f59e0b", PARK_CAPITAL: "#7dd3fc" };

export default function DeltaVault() {
  const [running, setRunning] = useState(false);
  const [prices, setPrices] = useState({ BTC: 68400, ETH: 3520 });
  const [funding, setFunding] = useState({ BTC: 0.00012, ETH: 0.000085 });
  const [basis, setBasis]     = useState({ BTC: 0.0082, ETH: 0.0061 });
  const [liquidity, setLiquidity] = useState({ BTC: 11.2e6, ETH: 5.4e6 });
  const [confidence, setConfidence] = useState({ BTC: 0, ETH: 0 });
  const [pythLive, setPythLive] = useState(false);
  const [lastPyth, setLastPyth] = useState(null);
  const [wallet, setWallet]   = useState({ connected: false, address: "", loading: false });
  const [signals, setSignals] = useState({ BTC: "PARK_CAPITAL", ETH: "PARK_CAPITAL" });
  const [positions, setPositions] = useState([]);
  const [vault, setVault]     = useState({ total: 100000, pnl: 0, drawdown: 0, delta: 0 });
  const [history, setHistory] = useState({
    pnl: Array(40).fill(0),
    btc: Array(40).fill(68400),
    eth: Array(40).fill(3520),
  });
  const [logs, setLogs]       = useState([]);
  const [riskFlags, setRiskFlags] = useState([]);
  const [orders, setOrders]   = useState([]);
  const [tick, setTick]       = useState(0);
  const logsRef = useRef(null);

  const addLog = useCallback((type, msg) => {
    const time = new Date().toTimeString().slice(0, 8);
    setLogs(p => [...p.slice(-160), { type, msg, time, id: Date.now() + Math.random() }]);
  }, []);

  // ── Pyth live prices ───────────────────────────────────────────────────────
  const pollPyth = useCallback(async () => {
    const data = await fetchPythPrices();
    if (data?.BTC?.price > 0) {
      setPrices(prev => ({
        BTC: data.BTC?.price ?? prev.BTC,
        ETH: data.ETH?.price ?? prev.ETH,
      }));
      setConfidence({ BTC: data.BTC?.confidence ?? 0, ETH: data.ETH?.confidence ?? 0 });
      setPythLive(true);
      setLastPyth(new Date().toTimeString().slice(0, 8));
      addLog("SYS", `Pyth ✓ BTC ${fmtUSD(data.BTC?.price)} · ETH ${fmtUSD(data.ETH?.price)}`);
    }
  }, [addLog]);

  useEffect(() => {
    pollPyth();
    const id = setInterval(pollPyth, 12000);
    return () => clearInterval(id);
  }, [pollPyth]);

  // ── Phantom wallet ─────────────────────────────────────────────────────────
  const connectPhantom = useCallback(async () => {
    setWallet(w => ({ ...w, loading: true }));
    try {
      const provider = typeof window !== "undefined" && window?.solana;
      if (!provider?.isPhantom) {
        addLog("RISK", "Phantom not found — install at phantom.app");
        alert("Phantom wallet not installed.\nGet it at https://phantom.app");
        return;
      }
      const resp = await provider.connect();
      const address = resp.publicKey.toBase58();
      setWallet({ connected: true, address, loading: false });
      addLog("SYS", `Phantom connected — ${address.slice(0, 6)}...${address.slice(-4)}`);
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
  const evalSignals = (fr, bs) => {
    const s = {};
    for (const a of ASSETS) {
      if (fr[a] > FUNDING_THRESHOLD) s[a] = "DELTA_NEUTRAL";
      else if (bs[a] > BASIS_THRESHOLD) s[a] = "BASIS_TRADE";
      else s[a] = "PARK_CAPITAL";
    }
    return s;
  };

  // ── Bot loop ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      setTick(t => t + 1);

      setFunding(f => { const n = {}; for (const a of ASSETS) n[a] = clamp(f[a] + rand(-0.000012, 0.000012), 0.00002, 0.0004); return n; });
      setBasis(b =>   { const n = {}; for (const a of ASSETS) n[a] = clamp(b[a] + rand(-0.0008, 0.0008), 0.001, 0.022); return n; });
      setLiquidity(l => { const n = {}; for (const a of ASSETS) n[a] = clamp(l[a] + rand(-250000, 250000), 1e6, 18e6); return n; });
      setPrices(p => {
        const n = { BTC: p.BTC * (1 + rand(-0.0009, 0.0009)), ETH: p.ETH * (1 + rand(-0.001, 0.001)) };
        setHistory(h => ({ ...h, btc: [...h.btc.slice(-39), n.BTC], eth: [...h.eth.slice(-39), n.ETH] }));
        return n;
      });

      setFunding(fr => {
        setBasis(bs => {
          const sigs = evalSignals(fr, bs);
          setSignals(sigs);
          for (const a of ASSETS) {
            if (sigs[a] === "DELTA_NEUTRAL") {
              setPositions(p => {
                if (p.find(x => x.asset === a)) return p;
                const sz = rand(2500, 9000);
                addLog("TRADE", `${a} DELTA_NEUTRAL open — spot long + perp short $${sz.toFixed(0)}`);
                setOrders(o => [{ id: Date.now(), time: new Date().toTimeString().slice(0,8), asset: a, leg: "PERP SHORT", size: sz, status: "FILLED" }, ...o.slice(0, 14)]);
                return [...p, { asset: a, type: "DELTA_NEUTRAL", size: sz, pnl: 0 }];
              });
            } else if (sigs[a] === "BASIS_TRADE") {
              setPositions(p => {
                if (p.find(x => x.asset === a && x.type === "BASIS_TRADE")) return p;
                const sz = rand(3000, 11000);
                addLog("TRADE", `${a} BASIS_TRADE open — basis ${fmtPct(bs[a], 2)}`);
                return [...p, { asset: a, type: "BASIS_TRADE", size: sz, pnl: 0 }];
              });
            } else {
              setPositions(p => {
                if (p.find(x => x.asset === a)) addLog("INFO", `${a}: capital parked — no opportunity`);
                return p.filter(x => x.asset !== a);
              });
            }
          }
          return bs;
        });
        return fr;
      });

      setPositions(prev => {
        const updated = prev.map(p => ({ ...p, pnl: p.pnl + p.size * rand(-0.00018, 0.00055) }));
        const totalPnl = updated.reduce((s, p) => s + p.pnl, 0);
        const dd = Math.abs(Math.min(0, totalPnl / 100000));
        const delta = updated.filter(p => p.type === "BASIS_TRADE").reduce((s, p) => s + p.size, 0) / 100000 * 0.04;
        setVault({ total: 100000 + totalPnl, pnl: totalPnl, drawdown: dd, delta });
        setHistory(h => ({ ...h, pnl: [...h.pnl.slice(-39), totalPnl] }));
        const flags = [];
        if (dd > 0.05) { flags.push("⚠ Drawdown > 5%"); addLog("RISK", "Drawdown > 5% threshold"); }
        if (delta > 0.05) { flags.push("⚠ Delta > 5%"); addLog("RISK", "Delta exposure > 5% — rebalance triggered"); }
        setRiskFlags(flags);
        return updated;
      });
      addLog("INFO", `Cycle #${tick + 1} — Hyperliquid funding scanned`);
    }, 2500);
    return () => clearInterval(id);
  }, [running, addLog, tick]);

  useEffect(() => { if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight; }, [logs]);

  // ─── RENDER ────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: "#06090e", color: "#dde4ef", fontFamily: "'JetBrains Mono',monospace", boxSizing: "border-box" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;600;700&family=Space+Grotesk:wght@500;700&display=swap');
        *{box-sizing:border-box}
        ::-webkit-scrollbar{width:3px} ::-webkit-scrollbar-thumb{background:#182030}
        .card{background:#0a0e16;border:1px solid #16202e;border-radius:8px;padding:13px}
        .blink{animation:blink 1s step-end infinite} @keyframes blink{50%{opacity:0}}
        .btn{cursor:pointer;border:none;border-radius:6px;font-family:monospace;font-size:11px;font-weight:700;letter-spacing:1px;padding:7px 15px;transition:all .15s}
        .btn:hover{filter:brightness(1.15)}
        .scanline{background:repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,255,163,.008) 3px,rgba(0,255,163,.008) 4px);pointer-events:none;position:fixed;inset:0;z-index:9999}
      `}</style>
      <div className="scanline" />

      {/* ══ SIMULATION MODE BANNER ══════════════════════════════════════════ */}
      <div style={{
        background: "repeating-linear-gradient(90deg,#140a00,#140a00 18px,#180b00 18px,#180b00 36px)",
        borderBottom: "2px solid #f59e0b44",
        padding: "7px 22px",
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "#f59e0b", letterSpacing: 2.5 }}>⚠ SIMULATION MODE</span>
            <span style={{ width: 1, height: 14, background: "#3a2a10", display: "inline-block" }} />
            <span style={{ fontSize: 9, color: "#6b4d1e" }}>No real funds at risk · Orders are paper-executed · Connect wallet to go live</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{
            fontSize: 9, padding: "2px 9px", borderRadius: 4, fontWeight: 700, letterSpacing: 1.5,
            background: pythLive ? "#001a0a" : "#0f0f00",
            color: pythLive ? "#00ffa3" : "#888",
            border: `1px solid ${pythLive ? "#00ffa344" : "#44440044"}`,
          }}>
            {pythLive ? "⬤ PYTH LIVE" : "◯ PYTH —"}
          </div>
          {lastPyth && <span style={{ fontSize: 8, color: "#3a4a3a" }}>last {lastPyth}</span>}
        </div>
      </div>

      <div style={{ padding: "16px 20px" }}>
        {/* ══ HEADER ══════════════════════════════════════════════════════════ */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, paddingBottom: 13, borderBottom: "1px solid #16202e" }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#00ffa3", letterSpacing: 2.5, fontFamily: "'Space Grotesk',sans-serif" }}>◈ DELTA VAULT</div>
            <div style={{ fontSize: 8, color: "#2a3a4a", letterSpacing: 3, marginTop: 2 }}>HYPERLIQUID · KAMINO · SOLANA · BTC/ETH/SOL/JTO · DELTA-NEUTRAL</div>
          </div>
          <div style={{ display: "flex", gap: 9, alignItems: "center" }}>
            {!wallet.connected ? (
              <button className="btn" onClick={connectPhantom} disabled={wallet.loading}
                style={{ background: "#0a0a1e", color: "#a78bfa", border: "1px solid #a78bfa44" }}>
                {wallet.loading ? "CONNECTING…" : "⬡ CONNECT PHANTOM"}
              </button>
            ) : (
              <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
                <div style={{ padding: "5px 10px", background: "#0a0d1a", border: "1px solid #a78bfa44", borderRadius: 6, fontSize: 9, color: "#a78bfa" }}>
                  ⬡ {short(wallet.address)}
                </div>
                <button className="btn" onClick={disconnectPhantom}
                  style={{ background: "#0f0808", color: "#f87171", border: "1px solid #f8717144", padding: "5px 10px", fontSize: 9 }}>
                  DISCONNECT
                </button>
              </div>
            )}
            <div style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 10, color: running ? "#00ffa3" : "#445" }}>
              <span className={running ? "blink" : ""} style={{ width: 6, height: 6, borderRadius: "50%", background: running ? "#00ffa3" : "#2a3040", display: "inline-block" }} />
              {running ? "LIVE" : "IDLE"}
            </div>
            <button className="btn" onClick={() => { setRunning(r => !r); addLog("SYS", running ? "Bot stopped by operator" : "Bot started — scanning Hyperliquid funding rates"); }}
              style={{ background: running ? "#120707" : "#071207", color: running ? "#f87171" : "#00ffa3", border: `1px solid ${running ? "#f8717155" : "#00ffa355"}` }}>
              {running ? "⏹ STOP BOT" : "▶ START BOT"}
            </button>
          </div>
        </div>

        {/* ══ RISK FLAGS ══════════════════════════════════════════════════════ */}
        {riskFlags.length > 0 && (
          <div style={{ marginBottom: 11, background: "#120707", border: "1px solid #f87171", borderRadius: 7, padding: "8px 13px", display: "flex", gap: 16 }}>
            {riskFlags.map((f, i) => <span key={i} style={{ color: "#f87171", fontSize: 10 }}>{f}</span>)}
          </div>
        )}

        {/* ══ TOP STATS ════════════════════════════════════════════════════════ */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 9, marginBottom: 11 }}>
          {[
            { label: "VAULT NAV",       val: fmtUSD(vault.total),     sub: `PnL ${vault.pnl >= 0 ? "+" : ""}${fmtUSD(vault.pnl)}`,      c: vault.pnl >= 0 ? "#00ffa3" : "#f87171" },
            { label: "OPEN POSITIONS",  val: positions.length,         sub: `${positions.filter(p => p.type === "DELTA_NEUTRAL").length} delta-neutral`, c: "#7dd3fc" },
            { label: "DRAWDOWN",        val: fmtPct(vault.drawdown,2), sub: vault.drawdown > 0.05 ? "⚠ HIGH" : "NORMAL",                 c: vault.drawdown > 0.05 ? "#f87171" : "#00ffa3" },
            { label: "DELTA EXPOSURE",  val: fmtPct(vault.delta,2),    sub: vault.delta > 0.05 ? "⚠ REBALANCE" : "NEUTRAL",              c: vault.delta > 0.05 ? "#fbbf24" : "#00ffa3" },
            { label: "PRICE SOURCE",    val: pythLive ? "PYTH" : "SIM", sub: pythLive ? "Pyth Network oracle" : "Simulated prices",       c: pythLive ? "#00ffa3" : "#fbbf24" },
          ].map(s => (
            <div key={s.label} className="card">
              <div style={{ fontSize: 7, color: "#2a3a4a", letterSpacing: 2, marginBottom: 4 }}>{s.label}</div>
              <div style={{ fontSize: 19, fontWeight: 700, color: s.c }}>{s.val}</div>
              <div style={{ fontSize: 8, color: "#384050", marginTop: 3 }}>{s.sub}</div>
            </div>
          ))}
        </div>

        {/* ══ ROW 1: Market Data + Strategy ═══════════════════════════════════ */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9, marginBottom: 9 }}>

          {/* ① Market Data Engine */}
          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={{ fontSize: 8, color: "#00ffa3", letterSpacing: 2, fontWeight: 700 }}>① MARKET DATA ENGINE</div>
              <div style={{ fontSize: 7, padding: "2px 7px", borderRadius: 3, fontWeight: 700, letterSpacing: 1,
                background: pythLive ? "#001a0a" : "#1a0f00", color: pythLive ? "#00ffa3" : "#f59e0b",
                border: `1px solid ${pythLive ? "#00ffa322" : "#f59e0b22"}` }}>
                {pythLive ? "PYTH NETWORK" : "SIMULATED"}
              </div>
            </div>
            {ASSETS.map(a => (
              <div key={a} style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 10px", background: "#060910", borderRadius: 6, border: "1px solid #141e2c", marginBottom: 6 }}>
                <div style={{ width: 28, fontWeight: 700, fontSize: 12 }}>{a}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>{fmtUSD(prices[a])}</div>
                  {confidence[a] > 0
                    ? <div style={{ fontSize: 7, color: "#445" }}>±{fmtUSD(confidence[a])} pyth conf</div>
                    : <div style={{ fontSize: 7, color: "#2a3040" }}>awaiting oracle…</div>
                  }
                </div>
                <div style={{ textAlign: "right", fontSize: 9 }}>
                  <div style={{ color: funding[a] > FUNDING_THRESHOLD ? "#00ffa3" : "#7dd3fc" }}>FR {fmtPct(funding[a])}</div>
                  <div style={{ color: basis[a] > BASIS_THRESHOLD ? "#f59e0b" : "#445" }}>BS {fmtPct(basis[a], 2)}</div>
                </div>
                <div style={{ width: 40, textAlign: "right", fontSize: 8 }}>
                  <div style={{ color: "#7dd3fc" }}>${(liquidity[a]/1e6).toFixed(1)}M</div>
                  <div style={{ color: "#384050" }}>OI</div>
                </div>
                <Spark data={a === "BTC" ? history.btc : history.eth} color={a === "BTC" ? "#f59e0b" : "#7dd3fc"} width={52} height={26} />
              </div>
            ))}
            <div style={{ fontSize: 8, color: "#2a3540", marginTop: 6, padding: "5px 8px", background: "#060910", borderRadius: 5 }}>
              Funding rates: Hyperliquid REST API · Spot prices: Pyth Network Hermes API · Basis: computed (perp−spot)/spot
            </div>
          </div>

          {/* ② Strategy Engine */}
          <div className="card">
            <div style={{ fontSize: 8, color: "#7dd3fc", letterSpacing: 2, fontWeight: 700, marginBottom: 10 }}>② STRATEGY ENGINE</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7, marginBottom: 10 }}>
              {ASSETS.map(a => (
                <div key={a} style={{ padding: "9px 11px", background: "#060910", borderRadius: 6, border: `1px solid ${(SIG_COLOR[signals[a]] || "#18222e")}28` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontWeight: 700, fontSize: 12 }}>{a}</span>
                    <span style={{ fontSize: 7.5, fontWeight: 700, letterSpacing: 1.5, color: SIG_COLOR[signals[a]], background: (SIG_COLOR[signals[a]] || "#888") + "18", padding: "2px 8px", borderRadius: 3 }}>
                      {signals[a] || "—"}
                    </span>
                  </div>
                  <div style={{ fontSize: 8.5, color: "#44566a", marginTop: 3 }}>
                    {signals[a] === "DELTA_NEUTRAL" && `Funding ${fmtPct(funding[a])} > 0.01% threshold — collecting yield`}
                    {signals[a] === "BASIS_TRADE" && `Basis ${fmtPct(basis[a], 2)} > 1% — targeting convergence`}
                    {signals[a] === "PARK_CAPITAL" && "Low opportunity — idle capital in stable yield"}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ padding: "9px 11px", background: "#060910", borderRadius: 6, border: "1px solid #141e2c" }}>
              <div style={{ fontSize: 8, color: "#7dd3fc", letterSpacing: 1, marginBottom: 5 }}>STRATEGY PSEUDOCODE</div>
              <code style={{ fontSize: 8, color: "#6a7a8a", lineHeight: 1.9 }}>
                scan_hyperliquid_funding_rates(BTC, ETH, SOL, JTO)<br/>
                if funding_rate {">"} 0.01%/hr:<br/>
                {"  "}jupiter_buy_spot(asset, size)<br/>
                {"  "}hyperliquid_short_perp(asset, size)<br/>
                elif basis_spread {">"} 1.0%:<br/>
                {"  "}execute_basis_trade(asset)<br/>
                else:<br/>
                {"  "}park_in_stable_yield(capital)
              </code>
            </div>
          </div>
        </div>

        {/* ══ ROW 2: Execution + Risk ══════════════════════════════════════════ */}
        <div style={{ display: "grid", gridTemplateColumns: "1.25fr 1fr", gap: 9, marginBottom: 9 }}>

          {/* ③ Execution Engine */}
          <div className="card">
            <div style={{ fontSize: 8, color: "#f59e0b", letterSpacing: 2, fontWeight: 700, marginBottom: 10 }}>③ EXECUTION ENGINE // HYPERLIQUID + JUPITER // SOLANA</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
              {[
                { l: "PERP DEX",  v: "Hyperliquid",    c: "#f59e0b" },
                { l: "SPOT",      v: "Jupiter v6",  c: "#00ffa3" },
                { l: "RPC",       v: "Helius",       c: "#7dd3fc" },
                { l: "WALLET",    v: wallet.connected ? short(wallet.address) : "Not connected", c: wallet.connected ? "#a78bfa" : "#445" },
              ].map(t => (
                <div key={t.l} style={{ flex: 1, background: "#060910", border: `1px solid ${t.c}1a`, borderRadius: 5, padding: "5px 7px", textAlign: "center" }}>
                  <div style={{ fontSize: 7, color: "#384050", letterSpacing: 1 }}>{t.l}</div>
                  <div style={{ fontSize: 8.5, color: t.c, fontWeight: 700, marginTop: 1 }}>{t.v}</div>
                </div>
              ))}
            </div>

            <div style={{ fontSize: 8, color: "#384050", letterSpacing: 1, marginBottom: 6 }}>OPEN POSITIONS</div>
            {positions.length === 0
              ? <div style={{ color: "#1e2a3a", fontSize: 11, padding: "10px 0", textAlign: "center" }}>No open positions</div>
              : positions.map((p, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 9px", background: "#060910", borderRadius: 5, border: "1px solid #141e2c", marginBottom: 5 }}>
                  <div>
                    <span style={{ fontWeight: 700, fontSize: 11 }}>{p.asset} </span>
                    <span style={{ fontSize: 7.5, color: SIG_COLOR[p.type], background: SIG_COLOR[p.type] + "18", padding: "1px 5px", borderRadius: 3 }}>{p.type}</span>
                    <div style={{ fontSize: 8, color: "#445", marginTop: 2 }}>Size: {fmtUSD(p.size)}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: p.pnl >= 0 ? "#00ffa3" : "#f87171" }}>
                      {p.pnl >= 0 ? "+" : ""}{fmtUSD(p.pnl)}
                    </div>
                    <div style={{ fontSize: 7.5, color: "#445" }}>UNREALIZED PnL</div>
                  </div>
                </div>
              ))
            }

            {orders.length > 0 && <>
              <div style={{ fontSize: 8, color: "#384050", letterSpacing: 1, marginTop: 9, marginBottom: 5 }}>RECENT ORDERS</div>
              {orders.slice(0, 4).map(o => (
                <div key={o.id} style={{ display: "flex", gap: 7, fontSize: 8.5, padding: "3px 8px", background: "#060910", borderRadius: 4, marginBottom: 3 }}>
                  <span style={{ color: "#2a3a4a" }}>{o.time}</span>
                  <span style={{ color: "#00ffa3" }}>{o.asset}</span>
                  <span style={{ color: "#7dd3fc" }}>{o.leg}</span>
                  <span style={{ color: "#fbbf24" }}>{fmtUSD(o.size)}</span>
                  <span style={{ marginLeft: "auto", color: "#00ffa3" }}>✓ {o.status}</span>
                </div>
              ))}
            </>}
          </div>

          {/* ④ Risk Engine */}
          <div className="card">
            <div style={{ fontSize: 8, color: "#f87171", letterSpacing: 2, fontWeight: 700, marginBottom: 10 }}>④ RISK ENGINE</div>
            <div style={{ display: "flex", justifyContent: "space-around", marginBottom: 10 }}>
              <Gauge value={vault.drawdown * 100} max={10} label="DRAWDOWN %" color={vault.drawdown > 0.05 ? "#f87171" : "#00ffa3"} />
              <Gauge value={vault.delta * 100}    max={10} label="DELTA EXP %" color={vault.delta > 0.05 ? "#fbbf24" : "#7dd3fc"} />
              <Gauge value={positions.length}     max={6}  label="POSITIONS"   color="#a78bfa" />
            </div>
            <div style={{ padding: "9px 10px", background: "#060910", borderRadius: 6, border: "1px solid #141e2c" }}>
              <div style={{ fontSize: 8, color: "#f87171", letterSpacing: 1, marginBottom: 5 }}>HARD LIMITS</div>
              <code style={{ fontSize: 8, color: "#6a7080", lineHeight: 1.9 }}>
                drawdown {">"} 10% → CLOSE ALL<br/>
                delta_exp {">"} 5% → REBALANCE<br/>
                single loss {">"} 7% → CLOSE LEG<br/>
                collateral {"<"} 20% → HALT ENTRIES
              </code>
            </div>
          </div>
        </div>

        {/* ══ ROW 3: PnL chart + Log ═══════════════════════════════════════════ */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.6fr", gap: 9 }}>
          <div className="card">
            <div style={{ fontSize: 8, color: "#a78bfa", letterSpacing: 2, fontWeight: 700, marginBottom: 10 }}>PnL + PRICE HISTORY</div>
            <div style={{ display: "flex", gap: 14, justifyContent: "center" }}>
              <div><div style={{ fontSize: 7, color: "#384050", marginBottom: 3 }}>VAULT PnL</div><Spark data={history.pnl} color={vault.pnl >= 0 ? "#00ffa3" : "#f87171"} width={110} height={50} /></div>
              <div><div style={{ fontSize: 7, color: "#384050", marginBottom: 3 }}>BTC</div><Spark data={history.btc} color="#f59e0b" width={110} height={50} /></div>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, fontSize: 8, color: "#2a3a4a" }}>
              <span>TICK #{tick}</span>
              <span>2.5s interval</span>
              <span style={{ color: running ? "#00ffa3" : "#445" }}>{running ? "● RUNNING" : "○ IDLE"}</span>
            </div>
          </div>

          <div className="card" style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 8, color: "#2a3a4a", letterSpacing: 2, fontWeight: 700, marginBottom: 7 }}>ACTIVITY LOG</div>
            <div ref={logsRef} style={{ flex: 1, overflowY: "auto", maxHeight: 175, display: "flex", flexDirection: "column", gap: 1 }}>
              {logs.length === 0
                ? <div style={{ color: "#1a2530", fontSize: 10, padding: 8 }}>Start the bot to see live activity…</div>
                : logs.map(l => <LogLine key={l.id} e={l} />)
              }
            </div>
          </div>
        </div>

        <div style={{ marginTop: 12, textAlign: "center", fontSize: 7.5, color: "#141e2a", letterSpacing: 2 }}>
          DELTA VAULT · SIMULATION MODE · HYPERLIQUID · KAMINO · SOLANA · BTC/ETH/SOL/JTO · NOT FINANCIAL ADVICE
        </div>
      </div>
    </div>
  );
}
