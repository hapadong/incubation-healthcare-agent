// HealthAgent stub: bridge messaging is not used (no desktop bridge)

/** Ring-buffer UUID set that caps memory at `capacity` entries. */
export class BoundedUUIDSet {
  constructor(capacity) {
    this._capacity = capacity
    this._set = new Set()
    this._ring = []
    this._pos = 0
  }
  has(uuid) { return this._set.has(uuid) }
  add(uuid) {
    if (this._set.has(uuid)) return
    if (this._ring.length >= this._capacity) {
      const evict = this._ring[this._pos]
      this._set.delete(evict)
      this._ring[this._pos] = uuid
      this._pos = (this._pos + 1) % this._capacity
    } else {
      this._ring.push(uuid)
    }
    this._set.add(uuid)
  }
}

export const sendEventToRemoteSession = async () => {}
export const subscribeToRemoteSession = () => () => {}
export default {}
