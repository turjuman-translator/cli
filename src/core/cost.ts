// Cost per track: accrues per engine period. Soniox bills stream
// minutes (connection open: the whole stream is billed, pauses included) × sonioxSttPerHour/60,
// plus sonioxTranslationPerHour/60 for its translation (always on).

import type { Config } from "../config.js";

export type Pricing = Config["pricing"];

/** A running engine period, for live cost estimates. */
export interface OpenPeriod {
  /** ms the stream has been open. */
  streamMs: number;
}

export class CostCounter {
  private streamMs = 0;

  constructor(private readonly pricing: Pricing) {}

  /** Close an engine period. */
  addPeriod(period: OpenPeriod): void {
    this.streamMs += period.streamMs;
  }

  /** USD so far, including the running periods. */
  usd(open: readonly OpenPeriod[] = []): number {
    const ms = this.streamMs + open.reduce((sum, p) => sum + p.streamMs, 0);
    const p = this.pricing;
    return (ms / 60_000) * ((p.sonioxSttPerHour + p.sonioxTranslationPerHour) / 60);
  }

  /** Totals for the session.log summary. */
  breakdown(open: readonly OpenPeriod[] = []): string {
    const ms = this.streamMs + open.reduce((sum, p) => sum + p.streamMs, 0);
    return `stream ${(ms / 60_000).toFixed(2)} min, $${this.usd(open).toFixed(4)}`;
  }
}
