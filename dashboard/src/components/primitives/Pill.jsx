import React from "react";

const SCOL = {
  DELTA_NEUTRAL: "#00ffa3",
  DELTA_NEUTRAL_REVERSE: "#a78bfa",
  BASIS_TRADE: "#f59e0b",
  PARK_CAPITAL: "#5ba8d0",
  NONE: "#3a4e62",
};

export const Pill = React.memo(({ label }) => {
  const c = SCOL[label] || "#3a4e62";
  return (
    <span
      style={{
        fontSize: 7.5,
        fontWeight: 800,
        letterSpacing: 1.5,
        color: c,
        background: c + "1a",
        border: `1px solid ${c}44`,
        padding: "2px 7px",
        borderRadius: 3,
        fontFamily: "monospace",
      }}
    >
      {label}
    </span>
  );
});

Pill.displayName = "Pill";
