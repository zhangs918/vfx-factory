/** Deterministic primitives shared by the runtime and regression harness. */
export class SeededRandom {
  private state = 1;

  reset(seed: number) {
    this.state = (Number.isFinite(seed) ? seed : 1) >>> 0;
    if (this.state === 0) this.state = 1;
  }

  next = () => {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class DeterministicClock {
  time = 0;
  readonly updates: number[] = [];

  reset() {
    this.time = 0;
    this.updates.length = 0;
  }

  advance(delta: number) {
    const applied = Math.max(0, delta);
    this.updates.push(applied);
    this.time += applied;
    return applied;
  }
}
