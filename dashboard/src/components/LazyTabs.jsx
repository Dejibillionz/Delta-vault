import React, { Suspense } from "react";
import { Card } from "../primitives";

/**
 * Lazy Tab Components - Code-split Architecture and How-It-Works tabs
 * Only loaded when user clicks the tab (saves ~30KB on initial load)
 */

// Lazy load the tab content
const ArchitectureTabLazy = React.lazy(() =>
  import("../tabs/ArchitectureTab").then((m) => ({
    default: m.ArchitectureTab,
  }))
);

const HowItWorksTabLazy = React.lazy(() =>
  import("../tabs/HowItWorksTab").then((m) => ({
    default: m.HowItWorksTab,
  }))
);

/**
 * Loading fallback for lazy tabs
 */
const TabFallback = () => (
  <Card style={{ padding: 20, textAlign: "center" }}>
    <div style={{ fontSize: 11, color: "#4a6a7a" }}>Loading...</div>
  </Card>
);

/**
 * Tab Loader HOC
 * Wraps lazy component with Suspense and error boundary
 */
export const withTabSuspense = (Component) => (props) => (
  <Suspense fallback={<TabFallback />}>
    <ErrorBoundary>
      <Component {...props} />
    </ErrorBoundary>
  </Suspense>
);

/**
 * Simple Error Boundary
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    console.error("Tab load error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <Card style={{ padding: 20, textAlign: "center" }}>
          <div style={{ fontSize: 11, color: "#f87171" }}>
            Failed to load tab content
          </div>
        </Card>
      );
    }
    return this.props.children;
  }
}

/**
 * Export lazy-loaded tab components
 */
export const ArchitectureTab = withTabSuspense(ArchitectureTabLazy);
export const HowItWorksTab = withTabSuspense(HowItWorksTabLazy);
