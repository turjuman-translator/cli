// Contract for the rule-based Athan / Iqama / Salah detection.
import type { PrayerEvent, SessionMode } from "../shared/protocol.js";

export type MarkerId =
  | "TAKBIR"
  | "SHAHADA1"
  | "SHAHADA2"
  | "HAYYA_SALAH"
  | "HAYYA_FALAH"
  | "QAD_QAMAT"
  | "FAJR"
  | "TAHLIL";

export interface DetectorSegment {
  id: string;
  /** Final source text (Arabic, not normalized). */
  text: string;
  /** Wall ms when the segment became final. */
  at: number;
  /** Silence before this segment's speech started (ms), from VAD/page speech events. */
  silenceBeforeMs: number;
  /**
   * Session ms of the speech (PipelineSegment.startMs/endMs), for the delivery
   * rate (sung Athan ≤ 1.6 words/s, Iqama > 2.2). Without them the rate is estimated from `at`.
   */
  startMs?: number | null;
  endMs?: number | null;
}

/** What the session should do with segments / the display, in order. */
export type DetectorAction =
  /** Pass this segment on to the blocks now. */
  | { type: "pass"; segment: DetectorSegment }
  /** Keep it back (a prayer call may be starting); show only the listening dots. */
  | { type: "hold"; segment: DetectorSegment }
  /** The hold ended without an event: pass these on to the blocks, in order. */
  | { type: "release"; segments: DetectorSegment[] }
  /** Event confirmed: discard the held segments, insert an event card, hide recent formula blocks. */
  | {
      type: "event-start";
      event: PrayerEvent;
      discarded: DetectorSegment[];
      hideFormulaBlocksSinceMs: number;
      /** Shown early on strong evidence; may still change or be retracted. */
      provisional?: boolean;
    }
  /** A provisional Athan turned out to be the Iqama (QAD_QAMAT): update the card. */
  | { type: "event-change"; from: PrayerEvent; to: PrayerEvent }
  /** A provisional card was a false alarm: hide it and show these segments. */
  | { type: "event-retract"; event: PrayerEvent; released: DetectorSegment[] }
  | { type: "event-end"; event: PrayerEvent }
  /** Salah (every segment during the prayer) or a prayer formula: never shown. */
  | { type: "suppress"; segment: DetectorSegment }
  | { type: "mode"; mode: SessionMode };

export interface EventDetectorApi {
  readonly mode: SessionMode;
  /** Quran stoplist must be ignored (Salah). */
  readonly salah: boolean;
  onSegment(seg: DetectorSegment): DetectorAction[];
  /** Call about every 500 ms: hold timeout, end-of-event silence, Salah timeout. */
  tick(now: number): DetectorAction[];
  /** Operator override; "none" returns to normal speech. */
  override(event: PrayerEvent | "none", now: number): DetectorAction[];
  /** ≥ 80 % of the words belong to marker phrases (exposed for tests and the pipeline). */
  isFormulaOnly(text: string): boolean;
  /** Markers found in a text (fuzzy ≥ 0.8 per phrase). */
  markers(text: string): MarkerId[];
}
