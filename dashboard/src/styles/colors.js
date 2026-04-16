/**
 * Color System
 * Single source of truth for all dashboard colors
 * Ensures consistency and makes theming easy
 */

export const colors = {
  // Primary accent (profit, success)
  accent: "#00ffa3",
  accentLight: "#00ffa322",
  accentDark: "#007a52",

  // Warning & caution
  warning: "#f59e0b",
  warningLight: "#f59e0b22",
  warningDark: "#d97706",

  // Error & critical
  error: "#f87171",
  errorLight: "#f8717122",
  errorDark: "#dc2626",

  // Info & neutral
  info: "#5ba8d0",
  infoLight: "#5ba8d022",
  infoDark: "#0c4a6e",

  // Secondary (AI, alternative)
  secondary: "#a78bfa",
  secondaryLight: "#a78bfa22",
  secondaryDark: "#7c3aed",

  // Success (trades, positive)
  success: "#34d399",
  successLight: "#34d39922",
  successDark: "#059669",

  // Backgrounds
  bgCard: "#0a0f1a",
  bgCardGradient: "linear-gradient(145deg, #0a0f1a 0%, #080d14 100%)",
  bgDark: "#050810",

  // Text
  textPrimary: "#e8eef8",
  textSecondary: "#8aa0b8",
  textTertiary: "#4a6a7a",
  textMuted: "#283848",
  textDark: "#1e2e3e",

  // Borders
  border: "#141e2e",
  borderLight: "#1e2e3e",
  borderLighter: "#2a3a4e",

  // Log colors
  log: {
    INFO: "#5ba8d0",
    TRADE: "#00ffa3",
    RISK: "#f87171",
    WARN: "#fbbf24",
    SYS: "#a78bfa",
    PYTH: "#34d399",
  },

  // Signal colors
  signal: {
    DELTA_NEUTRAL: "#00ffa3",
    DELTA_NEUTRAL_REVERSE: "#a78bfa",
    BASIS_TRADE: "#f59e0b",
    PARK_CAPITAL: "#5ba8d0",
    NONE: "#3a4e62",
  },
};

/**
 * Create color with opacity
 * @param {string} color - Hex color (e.g., '#00ffa3')
 * @param {number} opacity - 0-1, will be converted to 0-255
 */
export const withOpacity = (color, opacity) => {
  const hex = Math.round(opacity * 255)
    .toString(16)
    .padStart(2, "0");
  return color + hex;
};

/**
 * Create a color pair with light variant for text on dark background
 * @param {string} baseColor - Hex color
 * @returns {Object} { base, light } pair
 */
export const colorPair = (baseColor) => ({
  base: baseColor,
  light: baseColor + "22",
});
