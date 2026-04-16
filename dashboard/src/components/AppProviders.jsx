import React from "react";
import { MarketDataProvider } from "../contexts/MarketDataContext";
import { VaultMetricsProvider } from "../contexts/VaultMetricsContext";
import { UIProvider } from "../contexts/UIContext";

/**
 * App Providers Wrapper
 * Wraps entire app in context tree
 * Can be gradually migrated without breaking existing code
 */
export const AppProviders = ({ children }) => {
  return (
    <UIProvider>
      <MarketDataProvider>
        <VaultMetricsProvider>
          {children}
        </VaultMetricsProvider>
      </MarketDataProvider>
    </UIProvider>
  );
};
