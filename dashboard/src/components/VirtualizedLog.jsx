import React from "react";
import { FixedSizeList as List } from "react-window";
import { Log } from "../primitives";

/**
 * VirtualizedLog - Memory-efficient activity log viewer
 * Shows ~10 logs, keeps 200 in memory, virtualizes rendering
 * Reduces DOM nodes from 200 to ~10, huge performance gain
 */
export const VirtualizedLog = React.memo(({ logs = [], height = 200, itemSize = 20 }) => {
  if (logs.length === 0) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ fontSize: 9, color: "#4a6a7a" }}>No logs yet</span>
      </div>
    );
  }

  // Scroll to bottom by default
  const listRef = React.useRef(null);
  React.useEffect(() => {
    if (listRef.current && logs.length > 0) {
      listRef.current.scrollToItem(logs.length - 1, "end");
    }
  }, [logs.length]);

  const Row = ({ index, style }) => (
    <div style={style}>
      <Log e={logs[index]} />
    </div>
  );

  return (
    <List
      ref={listRef}
      height={height}
      itemCount={logs.length}
      itemSize={itemSize}
      width="100%"
      style={{ fontFamily: "monospace" }}
    >
      {Row}
    </List>
  );
});

VirtualizedLog.displayName = "VirtualizedLog";
