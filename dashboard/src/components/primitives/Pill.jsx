import React from "react";
import { colors } from "../../styles/colors";

export const Pill = React.memo(({ label }) => {
  const c = colors.signal[label] || "#3a4e62";
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
