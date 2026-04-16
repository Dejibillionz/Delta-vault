import React from "react";

export const Card = React.memo(({ children, style = {} }) => {
  return (
    <div
      style={{
        background: "linear-gradient(145deg, #0a0f1a 0%, #080d14 100%)",
        border: "1px solid #141e2e",
        borderRadius: 10,
        padding: 15,
        backdropFilter: "blur(3px)",
        ...style,
      }}
    >
      {children}
    </div>
  );
});

Card.displayName = "Card";
