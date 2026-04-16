/**
 * CircularBuffer - Fixed-size ring buffer
 * O(1) operations: add, get, no array copying
 * Memory-efficient: no garbage collection from .slice()
 * Perfect for history tracking (PnL, prices, drawdown)
 */
export class CircularBuffer {
  constructor(capacity = 50) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
    this.head = 0; // insertion point
    this.size = 0; // current elements
  }

  /**
   * Add element to buffer (O(1))
   * Overwrites oldest when full
   */
  push(value) {
    this.buffer[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) {
      this.size++;
    }
  }

  /**
   * Get element at index (O(1))
   * Wraps around circular structure
   */
  get(index) {
    if (index < 0 || index >= this.size) {
      return undefined;
    }
    const actualIndex = (this.head - this.size + index) % this.capacity;
    return this.buffer[actualIndex];
  }

  /**
   * Get all elements in order (O(n))
   * Returns array of current elements
   */
  toArray() {
    const result = new Array(this.size);
    for (let i = 0; i < this.size; i++) {
      result[i] = this.get(i);
    }
    return result;
  }

  /**
   * Get last N elements
   * Useful for recent history
   */
  getLast(n) {
    const start = Math.max(0, this.size - n);
    return this.toArray().slice(start);
  }

  /**
   * Clear buffer
   */
  clear() {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.size = 0;
  }

  /**
   * Current number of elements
   */
  getSize() {
    return this.size;
  }

  /**
   * Check if full
   */
  isFull() {
    return this.size === this.capacity;
  }
}
