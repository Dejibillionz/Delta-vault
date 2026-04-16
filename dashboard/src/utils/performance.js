/**
 * Performance Monitoring Utilities
 * Track render times, memory usage, and performance metrics
 */

/**
 * Mark start of operation
 */
export const mark = (label) => {
  if (typeof window !== "undefined" && window.performance) {
    window.performance.mark(`${label}-start`);
  }
};

/**
 * Measure time between marks
 */
export const measure = (label) => {
  if (typeof window !== "undefined" && window.performance) {
    const measureName = `${label}-measure`;
    try {
      window.performance.measure(
        measureName,
        `${label}-start`,
        `${label}-end`
      );
      const entries = window.performance.getEntriesByName(measureName);
      if (entries.length > 0) {
        const duration = entries[entries.length - 1].duration;
        console.log(`⏱️  ${label}: ${duration.toFixed(2)}ms`);
        return duration;
      }
    } catch (e) {
      // Marks might not exist
    }
  }
};

/**
 * Get current memory usage (available in Chrome/Edge)
 */
export const getMemoryUsage = () => {
  if (typeof window !== "undefined" && window.performance?.memory) {
    const memory = window.performance.memory;
    return {
      usedJSHeapSize: (memory.usedJSHeapSize / 1048576).toFixed(2) + " MB",
      totalJSHeapSize: (memory.totalJSHeapSize / 1048576).toFixed(2) + " MB",
      jsHeapSizeLimit: (memory.jsHeapSizeLimit / 1048576).toFixed(2) + " MB",
    };
  }
  return null;
};

/**
 * Measure render performance of a component
 * Usage: wrap component render in useEffect
 */
export const measureRender = (componentName, startTime) => {
  const endTime = performance.now();
  const duration = endTime - startTime;
  if (duration > 16.67) {
    // Longer than 60fps frame (16.67ms)
    console.warn(`🐢 ${componentName} took ${duration.toFixed(2)}ms to render`);
  } else {
    console.log(`✅ ${componentName} rendered in ${duration.toFixed(2)}ms`);
  }
};

/**
 * Log Web Vitals
 */
export const logWebVitals = (metric) => {
  console.log(`📊 ${metric.name}: ${metric.value.toFixed(2)}`);
};

/**
 * Create performance observer
 */
export const observePerformance = (entryType, callback) => {
  if (typeof window !== "undefined" && window.PerformanceObserver) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          callback(entry);
        }
      });
      observer.observe({ entryTypes: [entryType] });
      return observer;
    } catch (e) {
      console.error("PerformanceObserver not supported:", e);
    }
  }
};
