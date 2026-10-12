// Cache entries are auxiliary; eviction always falls back to native history.
export class BoundedCache<T> extends Map<string, T> {
  private weights = new Map<string, number>();
  private bytes = 0;
  constructor(
    private limit = 500,
    private budget = 32 * 1024 * 1024,
    private entryLimit = 4 * 1024 * 1024,
  ) {
    super();
  }
  override set(key: string, value: T) {
    this.delete(key);
    const weight = Buffer.byteLength(JSON.stringify(value));
    if (weight > this.entryLimit) return this;
    super.set(key, value);
    this.weights.set(key, weight);
    this.bytes += weight;
    while (this.size > this.limit || this.bytes > this.budget)
      this.delete(this.keys().next().value!);
    return this;
  }
  override get(key: string) {
    const value = super.get(key);
    if (value !== undefined) {
      super.delete(key);
      super.set(key, value);
    }
    return value;
  }
  override delete(key: string) {
    this.bytes -= this.weights.get(key) || 0;
    this.weights.delete(key);
    return super.delete(key);
  }
  override clear() {
    super.clear();
    this.weights.clear();
    this.bytes = 0;
  }
  get byteLength() {
    return this.bytes;
  }
}
