import React from "react";
import { Card } from "../primitives";
import { colors } from "../styles";

/**
 * ErrorBoundary - Catches React component errors
 * Prevents entire app from crashing on component error
 */
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      error Count: 0,
    };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    // Log error to console (in production, would send to error tracking service)
    console.error("ErrorBoundary caught error:", error, errorInfo);

    this.setState((prevState) => ({
      error,
      errorInfo,
      errorCount: prevState.errorCount + 1,
    }));

    // Alert after 3 errors (prevent spam)
    if (this.state.errorCount >= 3) {
      console.warn("Multiple errors detected, consider refreshing the page");
    }
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            padding: "20px",
            margin: "20px",
            background: colors.error + "11",
            border: `1px solid ${colors.error}`,
            borderRadius: "8px",
            fontFamily: "'DM Mono', monospace",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 700, color: colors.error, marginBottom: 10 }}>
            ⚠️ Something went wrong
          </div>

          <div style={{ fontSize: 10, color: colors.textSecondary, marginBottom: 12, lineHeight: 1.6 }}>
            <div>Error: {this.state.error?.message}</div>
            {process.env.NODE_ENV === "development" && (
              <details style={{ marginTop: 8, padding: "8px", background: colors.bgDark, borderRadius: 4 }}>
                <summary style={{ cursor: "pointer", color: colors.warning }}>
                  Stack trace
                </summary>
                <pre style={{ fontSize: 8, color: colors.textTertiary, overflow: "auto", marginTop: 8 }}>
                  {this.state.errorInfo?.componentStack}
                </pre>
              </details>
            )}
          </div>

          <button
            onClick={this.handleReset}
            style={{
              padding: "6px 12px",
              background: colors.accent,
              color: colors.bgDark,
              border: "none",
              borderRadius: "4px",
              fontSize: 10,
              fontWeight: 600,
              cursor: "pointer",
              transition: "all 150ms ease-in-out",
            }}
            onMouseOver={(e) => (e.target.style.opacity = "0.8")}
            onMouseOut={(e) => (e.target.style.opacity = "1")}
          >
            Try Again
          </button>

          {this.state.errorCount > 1 && (
            <div style={{ fontSize: 8, color: colors.warning, marginTop: 12 }}>
              Error occurred {this.state.errorCount} times. Consider refreshing the page.
            </div>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
