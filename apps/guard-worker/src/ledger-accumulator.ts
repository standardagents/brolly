import { worstQuality, type AggregationKind, type DataQualityState, type UsageObservation } from "@standardagents/brolly-core";

export interface AccumulatorWindowValue {
  value: number;
  estimatedCostUsd: number;
  quality: DataQualityState;
  sampleInterval: number | null;
  watermarkAt: number | null;
}

export interface AccumulatorMetric {
  day: number;
  cycle: number;
  estimatedDayUsd: number;
  estimatedCycleUsd: number;
  cycleSeedValue: number;
  baseline: number[];
  quality: DataQualityState;
  sampleInterval: number | null;
  cycleQuality: DataQualityState;
  cycleSampleInterval: number | null;
  cycleSeedQuality: DataQualityState;
  cycleSeedSampleInterval: number | null;
  watermarkAt: number | null;
}

export interface AccumulatorResource {
  metrics: Record<string, AccumulatorMetric>;
  windows: Record<string, Record<string, AccumulatorWindowValue>>;
  trimmedQuality?: Record<string, DataQualityState>;
  trimmedSampleInterval?: Record<string, number | null>;
  trimmedMaximum?: Record<string, number>;
  updatedAt: number;
}

export interface AccumulatorPayload {
  resources: Record<string, AccumulatorResource>;
  sealedAt?: number;
}

export interface AccumulatorChange {
  localDay?: string;
  billingCycleId?: string;
  resourceId: string;
  metricDefinitionId: string;
  metricKey: string;
  intervalValue: number;
  dayValue: number;
  cycleValue: number;
  estimatedDayUsd: number;
  estimatedCycleUsd: number;
  billedDayUsd?: number;
  billedCycleUsd?: number;
  quality: DataQualityState;
  sampleInterval: number | null;
  cycleQuality: DataQualityState;
  cycleSampleInterval: number | null;
  watermarkAt: number | null;
  rollingBaseline: number;
  periodStartAt: number;
  periodEndAt: number;
  historical: boolean;
}

export function applyAccumulatorObservations(
  input: AccumulatorPayload | null,
  observations: UsageObservation[],
  resourceIds: Map<UsageObservation, string>,
  aggregationKinds: Map<string, AggregationKind>,
  cycleSeeds: Map<string, Record<string, {
    value: number;
    estimatedCostUsd: number;
    quality?: DataQualityState;
    sampleInterval?: number | null;
  }>>,
): { payload: AccumulatorPayload; changes: AccumulatorChange[] } {
  const payload = input ?? { resources: {} };
  const changes = new Map<string, AccumulatorChange>();
  for (const observation of observations) {
    const resourceId = requiredResourceId(resourceIds, observation);
    const metricDefinitionId = `${observation.sample.asset.family}:${observation.sample.metric}`;
    const resource = payload.resources[resourceId] ??= { metrics: {}, windows: {}, updatedAt: observation.sample.end };
    const seed = cycleSeeds.get(resourceId)?.[metricDefinitionId];
    const metric = resource.metrics[metricDefinitionId] ??= {
      day: 0,
      cycle: seed?.value ?? 0,
      estimatedDayUsd: 0,
      estimatedCycleUsd: seed?.estimatedCostUsd ?? 0,
      cycleSeedValue: seed?.value ?? 0,
      baseline: [],
      quality: "complete",
      sampleInterval: 1,
      cycleQuality: seed?.quality ?? "complete",
      cycleSampleInterval: seed?.sampleInterval ?? 1,
      cycleSeedQuality: seed?.quality ?? "complete",
      cycleSeedSampleInterval: seed?.sampleInterval ?? 1,
      watermarkAt: null,
    };
    const windowKey = `${observation.collectorKey}:${observation.dataset}:${observation.sample.start}:${observation.sample.end}`;
    const window = resource.windows[windowKey] ??= {};
    const previous = window[metricDefinitionId];
    const next: AccumulatorWindowValue = {
      value: observation.sample.value,
      estimatedCostUsd: observation.sample.estimatedCostUsd ?? 0,
      quality: observation.quality,
      sampleInterval: observation.sampleInterval,
      watermarkAt: observation.watermarkAt,
    };
    const aggregation = aggregationKinds.get(metricDefinitionId) ?? "sum";
    const rollingBaseline = median(metric.baseline);
    if (aggregation === "sum") {
      metric.day += next.value - (previous?.value ?? 0);
      metric.cycle += next.value - (previous?.value ?? 0);
      metric.estimatedDayUsd += next.estimatedCostUsd - (previous?.estimatedCostUsd ?? 0);
      metric.estimatedCycleUsd += next.estimatedCostUsd - (previous?.estimatedCostUsd ?? 0);
    } else {
      metric.estimatedDayUsd += next.estimatedCostUsd - (previous?.estimatedCostUsd ?? 0);
      metric.estimatedCycleUsd += next.estimatedCostUsd - (previous?.estimatedCostUsd ?? 0);
    }
    window[metricDefinitionId] = next;
    if (!previous || previous.value !== next.value) {
      metric.baseline = [...metric.baseline, next.value].slice(-12);
    }
    resource.updatedAt = Math.max(resource.updatedAt, observation.sample.end);
    trimWindows(resource);
    if (aggregation === "maximum") {
      const retained = Object.values(resource.windows)
        .map(values => values[metricDefinitionId]?.value)
        .filter((value): value is number => value !== undefined);
      metric.day = Math.max(resource.trimmedMaximum?.[metricDefinitionId] ?? 0, ...retained);
      metric.cycle = Math.max(metric.cycleSeedValue ?? 0, metric.day);
    } else if (aggregation === "latest") {
      metric.day = next.value;
      metric.cycle = next.value;
    }
    metric.quality = worstQuality([
      ...(resource.trimmedQuality?.[metricDefinitionId] ? [resource.trimmedQuality[metricDefinitionId]!] : []),
      ...Object.values(resource.windows).map(values => values[metricDefinitionId]?.quality).filter(Boolean) as DataQualityState[],
    ]);
    metric.sampleInterval = worstSampleInterval([
      resource.trimmedSampleInterval?.[metricDefinitionId],
      ...Object.values(resource.windows).map(windowValues => windowValues[metricDefinitionId]?.sampleInterval),
    ]);
    metric.cycleQuality = worstQuality([metric.cycleSeedQuality ?? "complete", metric.quality]);
    metric.cycleSampleInterval = worstSampleInterval([metric.cycleSeedSampleInterval, metric.sampleInterval]);
    metric.watermarkAt = maximumWatermark(resource.windows, metricDefinitionId);
    const changeKey = `${resourceId}:${metricDefinitionId}`;
    const priorChange = changes.get(changeKey);
    const latestEvidence = !priorChange || observation.sample.end >= priorChange.periodEndAt;
    changes.set(changeKey, {
      resourceId,
      metricDefinitionId,
      metricKey: observation.sample.metric,
      intervalValue: latestEvidence ? next.value : priorChange.intervalValue,
      dayValue: metric.day,
      cycleValue: metric.cycle,
      estimatedDayUsd: metric.estimatedDayUsd,
      estimatedCycleUsd: metric.estimatedCycleUsd,
      quality: metric.quality,
      sampleInterval: latestEvidence ? next.sampleInterval : priorChange.sampleInterval,
      cycleQuality: metric.cycleQuality,
      cycleSampleInterval: metric.cycleSampleInterval,
      watermarkAt: latestEvidence ? next.watermarkAt : priorChange.watermarkAt,
      rollingBaseline: latestEvidence ? rollingBaseline : priorChange.rollingBaseline,
      periodStartAt: latestEvidence ? observation.sample.start : priorChange.periodStartAt,
      periodEndAt: latestEvidence ? observation.sample.end : priorChange.periodEndAt,
      historical: latestEvidence ? observation.historical : priorChange.historical,
    });
  }
  return { payload, changes: [...changes.values()] };
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : ((sorted[middle - 1] ?? 0) + sorted[middle]!) / 2;
}

function trimWindows(resource: AccumulatorResource): void {
  const keys = Object.keys(resource.windows);
  if (keys.length <= 16) return;
  keys.sort((left, right) => windowEnd(left) - windowEnd(right));
  for (const key of keys.slice(0, keys.length - 16)) {
    const windowValues = resource.windows[key];
    for (const [metricId, value] of Object.entries(windowValues ?? {})) {
      resource.trimmedQuality ??= {};
      resource.trimmedSampleInterval ??= {};
      resource.trimmedMaximum ??= {};
      resource.trimmedQuality[metricId] = worstQuality([resource.trimmedQuality[metricId] ?? "complete", value.quality]);
      resource.trimmedSampleInterval[metricId] = worstSampleInterval([
        resource.trimmedSampleInterval[metricId], value.sampleInterval,
      ]);
      resource.trimmedMaximum[metricId] = Math.max(resource.trimmedMaximum[metricId] ?? 0, value.value);
    }
    delete resource.windows[key];
  }
}

function windowEnd(key: string): number {
  return Number(key.split(":").at(-1)) || 0;
}

function worstSampleInterval(values: Array<number | null | undefined>): number | null {
  if (values.some(value => value === null)) return null;
  const numbers = values.filter((value): value is number => value !== undefined);
  return numbers.length ? Math.max(...numbers) : 1;
}

function maximumWatermark(windows: AccumulatorResource["windows"], metricId: string): number | null {
  const values = Object.values(windows).map(window => window[metricId]?.watermarkAt).filter((value): value is number => value !== null && value !== undefined);
  return values.length ? Math.max(...values) : null;
}

function requiredResourceId(resourceIds: Map<UsageObservation, string>, observation: UsageObservation): string {
  const id = resourceIds.get(observation);
  if (!id) throw new Error("Usage observation is missing a canonical resource id");
  return id;
}
