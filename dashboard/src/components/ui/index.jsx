import React from "react";
import { theme, colors } from "../styles";

/**
 * Button - Accessible, themed button component
 * Variants: primary, secondary, danger, ghost
 * Sizes: sm, md, lg
 */
export const Button = React.memo(
  ({
    children,
    variant = "primary",
    size = "md",
    onClick,
    disabled = false,
    style = {},
    ...props
  }) => {
    const variants = {
      primary: {
        background: colors.accent,
        color: colors.bgDark,
        border: `1px solid ${colors.accent}`,
        "&:hover": { background: colors.accentDark },
      },
      secondary: {
        background: colors.secondary,
        color: colors.bgDark,
        border: `1px solid ${colors.secondary}`,
        "&:hover": { background: colors.secondaryDark },
      },
      danger: {
        background: colors.error,
        color: colors.textPrimary,
        border: `1px solid ${colors.error}`,
        "&:hover": { background: colors.errorDark },
      },
      ghost: {
        background: "transparent",
        color: colors.textSecondary,
        border: `1px solid ${colors.border}`,
        "&:hover": { color: colors.textPrimary },
      },
    };

    const sizes = {
      sm: { padding: "4px 12px", fontSize: 8 },
      md: { padding: "8px 16px", fontSize: 10 },
      lg: { padding: "12px 20px", fontSize: 12 },
    };

    const baseStyle = {
      ...theme.components.button,
      ...variants[variant],
      ...sizes[size],
      opacity: disabled ? 0.5 : 1,
      cursor: disabled ? "not-allowed" : "pointer",
      pointerEvents: disabled ? "none" : "auto",
      transition: theme.transitions.fast,
      ...style,
    };

    return (
      <button
        onClick={onClick}
        disabled={disabled}
        style={baseStyle}
        {...props}
      >
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";

/**
 * Badge - Inline status indicator
 * Variants: success, warning, danger, info, neutral
 */
export const Badge = React.memo(({ children, variant = "neutral", style = {} }) => {
  const variants = {
    success: {
      background: colors.success + "22",
      color: colors.success,
      border: `1px solid ${colors.success}44`,
    },
    warning: {
      background: colors.warning + "22",
      color: colors.warning,
      border: `1px solid ${colors.warning}44`,
    },
    danger: {
      background: colors.error + "22",
      color: colors.error,
      border: `1px solid ${colors.error}44`,
    },
    info: {
      background: colors.info + "22",
      color: colors.info,
      border: `1px solid ${colors.info}44`,
    },
    neutral: {
      background: colors.borderLighter,
      color: colors.textTertiary,
      border: `1px solid ${colors.border}`,
    },
  };

  const baseStyle = {
    ...theme.components.badge,
    ...variants[variant],
    display: "inline-block",
    fontFamily: "'DM Mono', monospace",
    ...style,
  };

  return <span style={baseStyle}>{children}</span>;
});

Badge.displayName = "Badge";

/**
 * Input - Text input with theme support
 */
export const Input = React.memo(
  ({ placeholder, onChange, value, disabled = false, style = {}, ...props }) => {
    const baseStyle = {
      ...theme.components.input,
      "&:focus": { borderColor: colors.accent, outline: "none" },
      opacity: disabled ? 0.6 : 1,
      cursor: disabled ? "not-allowed" : "text",
      ...style,
    };

    return (
      <input
        type="text"
        placeholder={placeholder}
        onChange={onChange}
        value={value}
        disabled={disabled}
        style={baseStyle}
        {...props}
      />
    );
  }
);

Input.displayName = "Input";

/**
 * Toggle - On/off switch
 */
export const Toggle = React.memo(
  ({ checked = false, onChange, disabled = false, label, ...props }) => {
    const size = 20;
    const knobSize = 16;

    return (
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <div
          style={{
            position: "relative",
            width: size,
            height: size,
            background: checked ? colors.accent : colors.border,
            borderRadius: theme.borderRadius.full,
            transition: theme.transitions.fast,
            display: "flex",
            alignItems: "center",
            padding: 2,
          }}
        >
          <div
            style={{
              width: knobSize,
              height: knobSize,
              background: colors.textPrimary,
              borderRadius: theme.borderRadius.full,
              transition: theme.transitions.fast,
              transform: checked ? `translateX(${size - knobSize - 4}px)` : "translateX(0)",
            }}
          />
        </div>
        {label && (
          <span style={{ fontSize: theme.typography.sizes.sm, color: colors.textSecondary }}>
            {label}
          </span>
        )}
        <input
          type="checkbox"
          checked={checked}
          onChange={onChange}
          disabled={disabled}
          style={{ display: "none" }}
          {...props}
        />
      </label>
    );
  }
);

Toggle.displayName = "Toggle";

/**
 * Tooltip - Help text on hover
 */
export const Tooltip = React.memo(({ text, children, position = "top" }) => {
  const [show, setShow] = React.useState(false);

  const positionStyles = {
    top: {
      bottom: "100%",
      left: "50%",
      transform: "translateX(-50%)",
      marginBottom: 8,
    },
    right: {
      left: "100%",
      top: "50%",
      transform: "translateY(-50%)",
      marginLeft: 8,
    },
    bottom: {
      top: "100%",
      left: "50%",
      transform: "translateX(-50%)",
      marginTop: 8,
    },
    left: {
      right: "100%",
      top: "50%",
      transform: "translateY(-50%)",
      marginRight: 8,
    },
  };

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <div
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        style={{ cursor: "help" }}
      >
        {children}
      </div>
      {show && (
        <div
          style={{
            position: "absolute",
            background: colors.bgDark,
            color: colors.textPrimary,
            padding: "6px 10px",
            borderRadius: theme.borderRadius.sm,
            fontSize: theme.typography.sizes.xs,
            border: `1px solid ${colors.border}`,
            whiteSpace: "nowrap",
            zIndex: 1000,
            ...positionStyles[position],
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
});

Tooltip.displayName = "Tooltip";
