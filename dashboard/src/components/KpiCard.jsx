import React from "react";
import { Card } from "../primitives";

/**
 * KpiCard - Reusable KPI metric display
 * Shows label, value, unit, and optional trend spark
 */
export const KpiCard = React.memo(
  ({
    label,
    value,
    unit = "",
    color = "#00ffa3",
    spark = null,
    details = null,
    size = "sm",
  }) => {
    const sizes = {
      sm: { fontSize: 11, valueFontSize: 16, labelFontSize: 7 },
      md: { fontSize: 12, valueFontSize: 20, labelFontSize: 8 },
      lg: { fontSize: 13, valueFontSize: 24, labelFontSize: 9 },
    };

    const { fontSize, valueFontSize, labelFontSize } = sizes[size];

    return (
      <Card
        style={{
          padding: 10,
          textAlign: "center",
          minWidth: 80,
          flex: 1,
        }}
      >
        {/* Label */}
        <div
          style={{
            fontSize: labelFontSize,
            fontWeight: 700,
            color,
            letterSpacing: 1,
            marginBottom: 4,
            fontFamily: "monospace",
          }}
        >
          {label}
        </div>

        {/* Value */}
        <div
          style={{
            fontSize: valueFontSize,
            fontWeight: 800,
            color: "#e8eef8",
            marginBottom: 2,
            fontFamily: "DM Mono",
          }}
        >
          {typeof value === "number" ? value.toFixed(2) : value}
          {unit && (
            <span style={{ fontSize: valueFontSize * 0.6, color, marginLeft: 3 }}>
              {unit}
            </span>
          )}
        </div>

        {/* Spark (mini chart) */}
        {spark && <div style={{ marginTop: 6 }}>{spark}</div>}

        {/* Details */}
        {details && (
          <div style={{ fontSize: 7, color: "#4a6a7a", marginTop: 4 }}>
            {details}
          </div>
        )}
      </Card>
    );
  }
);

KpiCard.displayName = "KpiCard";
