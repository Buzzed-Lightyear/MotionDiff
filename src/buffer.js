/**
 * CircularBuffer — stores the last `capacity` ImageData objects.
 *
 * get(0) = most recent frame
 * get(k) = k frames ago
 */
export class CircularBuffer {
  /** @param {number} capacity */
  constructor(capacity) {
    this._cap = capacity;
    this._buf = new Array(capacity);
    this._head = -1;
    this._size = 0;
  }

  /** Push a new frame into the buffer. @param {ImageData} frame */
  push(frame) {
    this._head = (this._head + 1) % this._cap;
    this._buf[this._head] = frame;
    if (this._size < this._cap) this._size++;
  }

  /**
   * Retrieve frame at `offset` positions back from head.
   * get(0) = most recent, get(1) = one frame ago, etc.
   * Returns null if offset is out of range.
   * @param {number} offset
   * @returns {ImageData|null}
   */
  get(offset) {
    if (offset < 0 || offset >= this._size) return null;
    const idx = (this._head - offset + this._cap) % this._cap;
    return this._buf[idx];
  }

  /** @returns {number} */
  get size() { return this._size; }

  /** @returns {number} */
  get capacity() { return this._cap; }

  /** Clear all stored frames. */
  clear() {
    this._buf = new Array(this._cap);
    this._head = -1;
    this._size = 0;
  }
}
