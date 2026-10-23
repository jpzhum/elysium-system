interface SincKernel {
  weights: Float64Array;
  sum: number;
}

/** Reuse only identical binary phases; never quantize the resampling position. */
export class WindowedSinc {
  readonly radius: number;
  private readonly cutoff: number;
  private readonly phases = new Map<number, SincKernel>();
  private scratch: SincKernel | undefined;

  constructor(fromRate: number, toRate: number) {
    this.cutoff = Math.min(1, toRate / fromRate);
    this.radius = Math.ceil(12 / this.cutoff);
  }

  at(position: number): SincKernel {
    const phase = position - Math.floor(position);
    const cached = this.phases.get(phase);
    if (cached) return cached;
    // Irregular rates can have many exact floating-point phases. Keep storage
    // bounded and reuse one scratch kernel instead of allocating per sample.
    const kernel = this.phases.size < 128
      ? { weights: new Float64Array(this.radius * 2), sum: 0 }
      : this.scratch ??= { weights: new Float64Array(this.radius * 2), sum: 0 };
    let sum = 0;
    for (let index = 0; index < kernel.weights.length; index++) {
      const distance = phase - (index - this.radius + 1);
      const scaled = Math.PI * distance * this.cutoff;
      const sinc = Math.abs(scaled) < 1e-10 ? 1 : Math.sin(scaled) / scaled;
      const window = 0.5 + 0.5 * Math.cos(Math.PI * distance / this.radius);
      const weight = sinc * window * this.cutoff;
      kernel.weights[index] = weight;
      sum += weight;
    }
    kernel.sum = sum;
    if (this.phases.size < 128) this.phases.set(phase, kernel);
    return kernel;
  }
}
