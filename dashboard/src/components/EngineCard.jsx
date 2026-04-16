import React from "react";
import { Card, SectionHead } from "../primitives";

/**
 * EngineCard - Wrapper for numbered engine sections
 * Consistent styling for all 7 engines
 */
export const EngineCard = React.memo(
  ({ num, title, color, children, style = {} }) => {
    return (
      <Card style={{ ...style }}>
        <SectionHead n={num} label={title} color={color} />
        {children}
      </Card>
    );
  }
);

EngineCard.displayName = "EngineCard";
