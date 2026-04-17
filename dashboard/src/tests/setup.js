/**
 * Test Setup & Utilities
 * Configured for Vitest + React Testing Library
 */

import { expect, afterEach, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import "@testing-library/jest-dom";

// Cleanup after each test
afterEach(() => {
  cleanup();
});

/**
 * Custom render with all providers wrapped
 * Usage: in tests, use renderWithProviders instead of render
 */
import {
  MarketDataProvider,
  VaultMetricsProvider,
  UIProvider,
} from "../contexts";

export const renderWithProviders = (ui, options = {}) => {
  const Wrapper = ({ children }) => (
    <UIProvider>
      <MarketDataProvider>
        <VaultMetricsProvider>{children}</VaultMetricsProvider>
      </MarketDataProvider>
    </UIProvider>
  );

  return render(ui, { wrapper: Wrapper, ...options });
};

/**
 * Mock fetch globally
 */
global.fetch = vi.fn();

/**
 * Mock localStorage
 */
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
};
global.localStorage = localStorageMock;

/**
 * Mock window.matchMedia for responsive tests
 */
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

/**
 * Test utilities
 */
export const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

export const waitFor = async (callback, options = {}) => {
  const { timeout = 1000, interval = 50 } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      callback();
      return;
    } catch (e) {
      await wait(interval);
    }
  }

  throw new Error("Timeout waiting for condition");
};

/**
 * Create mock market data
 */
export const createMockMarketData = (overrides = {}) => ({
  prices: { BTC: 68450, ETH: 3515, SOL: 148, JTO: 3.2, ...overrides.prices },
  funding: { BTC: 0.0001, ETH: 0.00008, SOL: 0.00015, JTO: 0.0002, ...overrides.funding },
  basis: { BTC: 0.01, ETH: 0.008, SOL: 0.006, JTO: 0.009, ...overrides.basis },
  liquidity: { BTC: 12.4e6, ETH: 6.1e6, SOL: 4.2e6, JTO: 1.1e6, ...overrides.liquidity },
});

/**
 * Create mock vault metrics
 */
export const createMockVaultMetrics = (overrides = {}) => ({
  nav: 10000,
  pnl: 250,
  drawdown: 0.02,
  delta: 0.01,
  hwm: 10250,
  totalUnrealizedPnl: 120,
  equityTarget: 10000,
  ...overrides,
});

/**
 * Create mock position
 */
export const createMockPosition = (overrides = {}) => ({
  id: "BTC-001",
  asset: "BTC",
  type: "DELTA_NEUTRAL",
  size: 0.5,
  notional: 34225,
  pnl: 125,
  opened: "09:15:20",
  legs: 2,
  delta: 0.001,
  ...overrides,
});
