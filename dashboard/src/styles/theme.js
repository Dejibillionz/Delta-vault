/**
 * Theme System for Delta Vault Dashboard
 * Centralized design tokens: spacing, typography, shadows, etc.
 */

import { colors } from "./colors";

export const theme = {
  // ── SPACING (8px base scale) ───────────────────────────────────────────
  spacing: {
    xs: "4px",
    sm: "8px",
    md: "16px",
    lg: "24px",
    xl: "32px",
    "2xl": "48px",
  },

  // ── TYPOGRAPHY ───────────────────────────────────────────────────────────
  typography: {
    fonts: {
      heading: "'Syne', 'JetBrains Mono', monospace",
      body: "'DM Mono', monospace",
      mono: "'JetBrains Mono', monospace",
    },
    sizes: {
      xs: 7,    // 7px - micro labels
      sm: 8,    // 8px - small labels
      md: 10,   // 10px - body text
      lg: 12,   // 12px - larger body
      xl: 14,   // 14px - section titles
      "2xl": 16 // 16px - card titles
    },
    weights: {
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
      extrabold: 800,
    },
    lineHeights: {
      tight: 1.2,
      normal: 1.5,
      relaxed: 1.8,
      loose: 2,
    },
  },

  // ── BORDER RADIUS ──────────────────────────────────────────────────────
  borderRadius: {
    none: "0px",
    sm: "3px",
    md: "8px",
    lg: "12px",
    full: "9999px",
  },

  // ── SHADOWS ────────────────────────────────────────────────────────────
  shadows: {
    none: "none",
    sm: "0 1px 2px rgba(0,0,0,0.05)",
    md: "0 4px 6px rgba(0,0,0,0.1)",
    lg: "0 10px 15px rgba(0,0,0,0.1)",
    xl: "0 20px 25px rgba(0,0,0,0.1)",
  },

  // ── BREAKPOINTS ────────────────────────────────────────────────────────
  breakpoints: {
    xs: "320px",
    sm: "640px",
    md: "768px",
    lg: "1024px",
    xl: "1280px",
    "2xl": "1536px",
  },

  // ── TRANSITIONS ────────────────────────────────────────────────────────
  transitions: {
    fast: "150ms ease-in-out",
    normal: "300ms ease-in-out",
    slow: "500ms ease-in-out",
  },

  // ── COLORS (from colors.js) ────────────────────────────────────────────
  colors,

  // ── COMPONENT-SPECIFIC TOKENS ──────────────────────────────────────────
  components: {
    card: {
      background: colors.bgCard,
      backgroundGradient: colors.bgCardGradient,
      border: colors.border,
      borderRadius: "10px",
      padding: "15px",
      transition: "all 150ms ease-in-out",
    },
    button: {
      padding: "8px 16px",
      borderRadius: "6px",
      fontSize: "10px",
      fontWeight: 600,
      transition: "all 150ms ease-in-out",
      minHeight: "36px", // Touch-friendly
      minWidth: "36px",
    },
    input: {
      padding: "8px 12px",
      borderRadius: "6px",
      fontSize: "10px",
      border: `1px solid ${colors.border}`,
      background: colors.bgDark,
      color: colors.textPrimary,
      transition: "all 150ms ease-in-out",
      minHeight: "36px", // Touch-friendly
    },
    badge: {
      padding: "4px 8px",
      borderRadius: "4px",
      fontSize: "7px",
      fontWeight: 700,
      letterSpacing: "1px",
    },
  },

  // ── UTILITIES ──────────────────────────────────────────────────────────
  utils: {
    flexCenter: {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    },
    flexBetween: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
    },
    flexCol: {
      display: "flex",
      flexDirection: "column",
    },
    truncate: {
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    },
    ghostButton: {
      background: "transparent",
      border: "none",
      cursor: "pointer",
      padding: 0,
      fontFamily: "'DM Mono', monospace",
    },
  },
};

/**
 * Media query helpers
 */
export const media = {
  xs: "@media (min-width: 320px)",
  sm: "@media (min-width: 640px)",
  md: "@media (min-width: 768px)",
  lg: "@media (min-width: 1024px)",
  xl: "@media (min-width: 1280px)",
  "2xl": "@media (min-width: 1536px)",
};

/**
 * Utility function to create consistent component styles
 */
export const createComponentStyle = (base, variant = "default") => {
  const variants = {
    default: {},
    hover: { opacity: 0.8, transform: "translateY(-1px)" },
    active: { opacity: 0.7 },
    disabled: { opacity: 0.5, cursor: "not-allowed", pointerEvents: "none" },
  };
  return { ...base, ...variants[variant] };
};
