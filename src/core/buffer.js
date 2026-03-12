export class CircularBuffer {
  constructor(capacity) {
    this._cap = capacity;
    this._buf = new Array(capacity);
    this._head = -1;
    this._size = 0;
  }

  push(frame) {
    this._head = (this._head + 1) % this._cap;
    this._buf[this._head] = frame;
    if (this._size < this._cap) this._size++;
  }

  get(offset) {
    if (offset < 0 || offset >= this._size) return null;
    const idx = (this._head - offset + this._cap) % this._cap;
    return this._buf[idx];
  }

  get size() { return this._size; }

  get capacity() { return this._cap; }

  clear() {
    this._buf = new Array(this._cap);
    this._head = -1;
    this._size = 0;
  }
}
