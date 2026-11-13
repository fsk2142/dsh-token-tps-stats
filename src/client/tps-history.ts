export const TPS_SAMPLE_MS = 100;
export const TPS_CHART_DEFAULT_SECONDS = 60;
export const TPS_CHART_RANGES = [60, 180, 300] as const;
export type TpsChartRange = (typeof TPS_CHART_RANGES)[number];

const RETENTION_MS = 300_000;
// A delayed UI tick may arrive after a suspension. Do not extend the last reading across the gap.
const MAX_HOLD_MS = 2 * TPS_SAMPLE_MS;

export interface TpsSeriesPoint {
  readonly at: number;
  readonly value: number;
}

export interface TpsSeriesSummary {
  readonly latest: number;
  readonly average: number;
  readonly peak: number;
}

export interface TpsHistory {
  record(at: number, value: number): void;
  view(at: number, seconds: number): { points: TpsSeriesPoint[]; summary: TpsSeriesSummary };
}

/** Record the displayed samples. Keep each second's peak at its measured position. */
export function createTpsHistory(): TpsHistory {
  let samples: TpsSeriesPoint[] = [];
  let head = 0;

  const prune = (at: number): void => {
    while (head < samples.length && samples[head]!.at + MAX_HOLD_MS < at - RETENTION_MS) head += 1;
    if (head > 512 && head >= samples.length / 2) {
      samples = samples.slice(head);
      head = 0;
    }
  };

  return {
    record(at, value) {
      const last = samples.at(-1);
      if (last !== undefined && at < last.at) return;
      if (last?.at === at) samples[samples.length - 1] = { at, value };
      else samples.push({ at, value });
      prune(at);
    },
    view(at, seconds) {
      prune(at);
      const span = Math.min(RETENTION_MS, Math.max(1, seconds) * 1_000);
      const from = at - span;
      const peaks = new Map<number, TpsSeriesPoint>();
      let area = 0;
      let peak = 0;
      let latest = 0;
      let first = 0;
      const addPeak = (point: TpsSeriesPoint): void => {
        const bin = Math.floor(point.at / 1_000);
        if ((peaks.get(bin)?.value ?? -1) < point.value) peaks.set(bin, point);
        peak = Math.max(peak, point.value);
      };
      for (let index = head; index < samples.length; index += 1) {
        const sample = samples[index]!;
        if (sample.at > at) break;
        const end = Math.min(at, samples[index + 1]?.at ?? at, sample.at + MAX_HOLD_MS);
        const begin = Math.max(from, sample.at);
        if (end >= begin) {
          area += sample.value * (end - begin);
          addPeak({ at: begin, value: sample.value });
          if (begin === from) first = sample.value;
          if (end === at) latest = sample.value;
        }
        const next = samples[index + 1]?.at ?? Infinity;
        if (sample.value > 0 && end >= from && end < Math.min(next, at)) {
          addPeak({ at: end, value: 0 });
        }
      }
      const points: TpsSeriesPoint[] = [{ at: from, value: first }];
      // Insert empty seconds too, so the chart does not interpolate across idle gaps.
      for (let bin = Math.floor(from / 1_000); bin <= Math.floor(at / 1_000); bin += 1) {
        const point = peaks.get(bin) ?? { at: bin * 1_000, value: 0 };
        if (point.at > from && point.at < at) points.push(point);
      }
      points.push({ at, value: latest });
      return { points, summary: { latest, average: area / span, peak } };
    },
  };
}
