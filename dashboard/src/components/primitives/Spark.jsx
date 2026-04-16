import React from "react";

export const Spark = React.memo(({ data = [], color = "#00ffa3", w = 80, h = 32 }) => {
  if (data.length < 2) return <svg width={w} height={h} />;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const px = (v, i) => [
    (i / (data.length - 1)) * w,
    h - ((v - min) / range) * (h - 4) - 2,
  ];

  const pts = data.map((v, i) => px(v, i).join(",")).join(" ");
  const area =
    `M 0,${h} ` +
    data.map((v, i) => `L ${px(v, i).join(",")}`).join(" ") +
    ` L ${w},${h} Z`;
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
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
});

Spark.displayName = "Spark";
