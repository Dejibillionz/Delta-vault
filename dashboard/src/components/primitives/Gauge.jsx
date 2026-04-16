import React from "react";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const Gauge = React.memo(({ value, max, label, color, size = 88 }) => {
  const pct = clamp(value / max, 0, 1);
  const R = size * 0.38;
  const cx = size / 2;
  const cy = size * 0.55;

  const ang = (deg) => ({
    x: cx + R * Math.cos((deg * Math.PI) / 180),
    y: cy + R * Math.sin((deg * Math.PI) / 180),
  });

  const s = ang(-135);
  const e = ang(-135 + pct * 270);
  const big = pct > 0.5 ? 1 : 0;

  return (
    <div style={{ textAlign: "center", width: size }}>
      <svg width={size} height={size * 0.72}>
        <path
          d={`M ${ang(-135).x} ${ang(-135).y} A ${R} ${R} 0 1 1 ${ang(135).x} ${ang(135).y}`}
          fill="none"
          stroke="#111820"
          strokeWidth={5}
          strokeLinecap="round"
        />
        {pct > 0.005 && (
          <path
            d={`M ${s.x} ${s.y} A ${R} ${R} 0 ${big} 1 ${e.x} ${e.y}`}
            fill="none"
            stroke={color}
            strokeWidth={5}
            strokeLinecap="round"
          />
        )}
        <text
          x={cx}
          y={cy + 2}
          textAnchor="middle"
          fill="#e8eef8"
          fontSize={size * 0.135}
          fontWeight="700"
          fontFamily="monospace"
        >
          {(pct * 100).toFixed(0)}%
        </text>
      </svg>
      <div
        style={{
          fontSize: 8,
          color: "#3a4e62",
          letterSpacing: 1,
          marginTop: -4,
          fontFamily: "monospace",
        }}
      >
        {label}
      </div>
    </div>
  );
});

Gauge.displayName = "Gauge";
