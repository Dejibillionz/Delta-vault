import React from "react";

export const PnLChart = React.memo(
  ({ data = [], vaultInitial = 10000, cycleSeconds = 15, color = "#00ffa3", w = 200, h = 60 }) => {
    if (data.length < 2) return <svg width={w} height={h} />;

    const n = data.length;
    const APY = 0.045;
    const YEAR_S = 365 * 24 * 3600;
    const baseline = data.map((_, i) => (vaultInitial * APY * (i * cycleSeconds)) / YEAR_S);
    const allVals = [...data, ...baseline, 0];
    const minV = Math.min(...allVals);
    const maxV = Math.max(...allVals);
    const range = maxV - minV || 1;
    const pad = { top: 6, bottom: 14, left: 26, right: 10 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;
    const py = (v) => pad.top + ch - ((v - minV) / range) * ch;
    const px = (i) => pad.left + (i / (n - 1)) * cw;

    const pnlPts = data.map((v, i) => `${px(i)},${py(v)}`).join(" ");
    const basePts = baseline.map((v, i) => `${px(i)},${py(v)}`).join(" ");
    const zeroY = py(0);
    const areaPath =
      `M ${px(0)},${zeroY} ` +
      data.map((v, i) => `L ${px(i)},${py(v)}`).join(" ") +
      ` L ${px(n - 1)},${zeroY} Z`;
    const gid = `pnlArea${w}`;
    const labelMax = maxV > 0 ? `+$${maxV.toFixed(0)}` : `$${maxV.toFixed(0)}`;

    return (
      <svg width={w} height={h} style={{ overflow: "visible", display: "block" }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.25" />
            <stop offset="100%" stopColor={color} stopOpacity="0.0" />
          </linearGradient>
        </defs>
        <line
          x1={pad.left}
          y1={zeroY}
          x2={w - pad.right}
          y2={zeroY}
          stroke="#1e2e3e"
          strokeWidth="1"
        />
        <polyline
          points={basePts}
          fill="none"
          stroke="#a78bfa"
          strokeWidth="1"
          strokeDasharray="3 3"
          opacity="0.7"
        />
        <text
          x={w - pad.right + 2}
          y={py(baseline[n - 1]) + 3}
          fontSize="6"
          fill="#a78bfa"
          opacity="0.8"
        >
          4.5% APY
        </text>
        <path d={areaPath} fill={`url(#${gid})`} />
        <polyline
          points={pnlPts}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <text
          x={pad.left - 2}
          y={pad.top + 5}
          fontSize="6"
          fill="#3a4e62"
          textAnchor="end"
        >
          {labelMax}
        </text>
        <text
          x={pad.left - 2}
          y={zeroY + 3}
          fontSize="6"
          fill="#3a4e62"
          textAnchor="end"
        >
          $0
        </text>
      </svg>
    );
  }
);

PnLChart.displayName = "PnLChart";
