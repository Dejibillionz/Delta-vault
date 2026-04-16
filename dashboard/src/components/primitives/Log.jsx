import React from "react";

const LCOLOR = {
  INFO: "#5ba8d0",
  TRADE: "#00ffa3",
  RISK: "#f87171",
  WARN: "#fbbf24",
  SYS: "#a78bfa",
  PYTH: "#34d399",
};

export const Log = React.memo(({ e }) => {
  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        fontSize: 10,
        fontFamily: "monospace",
        lineHeight: 1.65,
        padding: "1px 0",
      }}
    >
      <span style={{ color: "#283848", flexShrink: 0, width: 54 }}>{e.time}</span>
      <span style={{ color: LCOLOR[e.type] || "#888", width: 46, flexShrink: 0 }}>
        [{e.type}]
      </span>
      <span style={{ color: "#8aa0b8" }}>{e.msg}</span>
    </div>
  );
});

Log.displayName = "Log";
