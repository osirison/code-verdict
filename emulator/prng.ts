/** Deterministic PRNG (mulberry32) — same seed, same world, every run. */
export class Prng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }

  hex(length: number): string {
    let out = '';
    while (out.length < length) {
      out += this.int(0, 15).toString(16);
    }
    return out;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }
}
