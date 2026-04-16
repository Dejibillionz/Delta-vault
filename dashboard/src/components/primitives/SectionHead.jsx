import React from "react";

export const SectionHead = React.memo(({ n, label, color }) => {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 11 }}>
      <div
        style={{
          width: 20,
          height: 20,
          borderRadius: 5,
          background: color + "18",
          border: `1px solid ${color}44`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 9,
          fontWeight: 800,
          color,
          fontFamily: "monospace",
        }}
      >
        {n}
      </div>
      <span
        style={{
          fontSize: 8,
          fontWeight: 700,
          letterSpacing: 2.5,
          color,
          fontFamily: "monospace",
        }}
      >
        {label}
      </span>
    </div>
  );
});

SectionHead.displayName = "SectionHead";
