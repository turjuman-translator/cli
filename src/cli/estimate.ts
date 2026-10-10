import { parseArgs } from "node:util";
import type { Config, LoadedConfig } from "../config.js";
import type { CliIo } from "./index.js";

/** USD per minute of a session: Soniox speech recognition plus its translation. */
export function enginePerMin(c: Config): number {
  return (c.pricing.sonioxSttPerHour + c.pricing.sonioxTranslationPerHour) / 60;
}

const usd = (v: number): string => `$${v < 0.1 ? v.toFixed(4) : v.toFixed(2)}`;

/** `turjuman estimate start`: one-line cost estimate (Makefile paid targets). */
export function estimateCommand(args: string[], io: CliIo, loaded: LoadedConfig): number {
  // A wrong option throws: exit 2 with the usage (index.ts).
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  if (positionals.length === 1 && positionals[0] === "start") {
    const perMin = enginePerMin(loaded.config);
    io.out(
      `Estimated cost: ${usd(perMin)}/min (≈ ${usd(perMin * 60)}/hour) for Soniox, billed while the session runs.`,
    );
    return 0;
  }
  io.err("usage: turjuman estimate start");
  return 2;
}
