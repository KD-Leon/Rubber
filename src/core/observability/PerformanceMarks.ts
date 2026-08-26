/**
 * PerformanceMarks
 *
 * Lightweight wrapper around the Web Performance API for timing the
 * Vault Operator hot path (boot, sidebar onOpen, agent loop, provider
 * call, first token). Used by MEAS-01..02 to produce comparable
 * baselines across releases.
 *
 * Two primitives:
 *   - Span:  start(label) + end(label) -> measure with duration
 *   - Point: point(label) -> single timestamp (e.g. first-token)
 *
 * Internal storage avoids the global performance.measure() / mark()
 * registries to stay self-contained: it can be cleared without leaking
 * into other consumers of the Performance API.
 */

export interface PerfMeasure {
    name: string;
    duration: number;
    startTime: number;
}

export interface PerfPoint {
    name: string;
    timestamp: number;
}

export interface MarkOptions {
    log?: boolean;
}

export interface PerfReport {
    measures: PerfMeasure[];
    points: PerfPoint[];
}

function nowMs(): number {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return 0;
}

export class PerformanceMarks {
    private active = new Map<string, number>();
    private measures: PerfMeasure[] = [];
    private points: PerfPoint[] = [];

    start(label: string): void {
        this.active.set(label, nowMs());
    }

    end(label: string, opts: MarkOptions = {}): PerfMeasure | null {
        const startTime = this.active.get(label);
        if (startTime === undefined) {
            return null;
        }
        this.active.delete(label);
        const duration = nowMs() - startTime;
        const measure: PerfMeasure = { name: label, duration, startTime };
        this.measures.push(measure);
        if (opts.log) {
            console.debug(`[perf] ${label}: ${duration.toFixed(1)} ms`);
        }
        return measure;
    }

    point(label: string, opts: MarkOptions = {}): PerfPoint {
        const point: PerfPoint = { name: label, timestamp: nowMs() };
        this.points.push(point);
        if (opts.log) {
            console.debug(`[perf] ${label} @ ${point.timestamp.toFixed(1)} ms`);
        }
        return point;
    }

    getMeasures(): PerfMeasure[] {
        return [...this.measures];
    }

    getPoints(): PerfPoint[] {
        return [...this.points];
    }

    clear(): void {
        this.active.clear();
        this.measures = [];
        this.points = [];
    }

    toJSON(): PerfReport {
        return {
            measures: this.getMeasures(),
            points: this.getPoints(),
        };
    }
}

let singleton: PerformanceMarks | null = null;

export function getPerformanceMarks(): PerformanceMarks {
    if (!singleton) {
        singleton = new PerformanceMarks();
    }
    return singleton;
}

export function resetPerformanceMarksForTests(): void {
    singleton = null;
}
