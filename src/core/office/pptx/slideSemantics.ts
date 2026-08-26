import type { ShapeEntry, SlideSemanticFamily, SlideWarningFlag } from './types';

const PLACEHOLDER_PATTERNS = [
    /lorem ipsum/i,
    /\bplatzhalter\b/i,
    /\bplaceholder\b/i,
    /\bname nachname\b/i,
    /\bdatum[, ]+ort\b/i,
    /\bkapitelname\b/i,
    /\breferent\b/i,
    /\btitel zwei-/i,
];

const STYLE_GUIDE_PATTERNS = [
    /\bguideline(s)?\b/i,
    /\bstyle ?guide\b/i,
    /\bicon(s)?\b/i,
    /\blibrary\b/i,
    /\btemplate\b/i,
    /\bvorlage\b/i,
    /\bvorgaben\b/i,
    /\bfolienbibliothek\b/i,
    /\blinien?\b/i,
    /\bpfeile?\b/i,
    /\bformen?\b/i,
];

const AGENDA_PATTERNS = [
    /\bagenda\b/i,
    /\binhalt\b/i,
    /\bcontents?\b/i,
    /table of contents/i,
];

const SECTION_PATTERNS = [
    /\bkapitel\b/i,
    /\bchapter\b/i,
    /\bsection\b/i,
    /\bteil\b/i,
];

const CLOSING_PATTERNS = [
    /\bvielen dank\b/i,
    /\bthank you\b/i,
    /\bfragen\b/i,
    /\bkontakt\b/i,
    /\bcontact\b/i,
];

const QUOTE_PATTERNS = [
    /\bich bin ein zitat\b/i,
    /\bquote\b/i,
    /\bzitat\b/i,
];

type Role = ShapeEntry['role'];

type RoleCounts = Record<Role, number>;

function countRoles(shapes: ShapeEntry[]): RoleCounts {
    return shapes.reduce<RoleCounts>((acc, shape) => {
        acc[shape.role] = (acc[shape.role] ?? 0) + 1;
        return acc;
    }, {
        title: 0,
        subtitle: 0,
        body: 0,
        kpi_value: 0,
        kpi_label: 0,
        step_label: 0,
        step_desc: 0,
        image: 0,
        chart: 0,
        table: 0,
        decorative: 0,
    });
}

function getNonDecorativeShapes(shapes: ShapeEntry[]): ShapeEntry[] {
    return shapes.filter(shape => shape.role !== 'decorative');
}

function getTextCorpus(shapes: ShapeEntry[]): string {
    return shapes
        .map(shape => shape.sample_text?.trim())
        .filter((text): text is string => Boolean(text))
        .join(' \n ');
}

function countMatches(corpus: string, patterns: RegExp[]): number {
    return patterns.reduce((count, pattern) => count + (pattern.test(corpus) ? 1 : 0), 0);
}

function hasTwoColumnBody(shapes: ShapeEntry[]): boolean {
    const bodies = shapes.filter(shape => shape.role === 'body' && shape.dimensions);
    if (bodies.length < 2) return false;

    const leftBodies = bodies.filter(shape => {
        const box = shape.dimensions!;
        return box.x + box.w / 2 < 1280 / 2;
    });
    const rightBodies = bodies.filter(shape => {
        const box = shape.dimensions!;
        return box.x + box.w / 2 >= 1280 / 2;
    });

    return leftBodies.length > 0 && rightBodies.length > 0;
}

function hasHorizontalSequence(shapes: ShapeEntry[], minCount: number): boolean {
    const positioned = shapes.filter(shape => shape.dimensions);
    if (positioned.length < minCount) return false;

    const centers = positioned.map(shape => ({
        x: shape.dimensions!.x + shape.dimensions!.w / 2,
        y: shape.dimensions!.y + shape.dimensions!.h / 2,
    }));
    const minX = Math.min(...centers.map(center => center.x));
    const maxX = Math.max(...centers.map(center => center.x));
    const minY = Math.min(...centers.map(center => center.y));
    const maxY = Math.max(...centers.map(center => center.y));

    return (maxX - minX) > 420 && (maxY - minY) < 220;
}

export function inferSlideSemanticFamily(shapes: ShapeEntry[]): SlideSemanticFamily {
    const relevantShapes = getNonDecorativeShapes(shapes);
    const counts = countRoles(relevantShapes);
    const textCorpus = getTextCorpus(relevantShapes);

    if (countMatches(textCorpus, CLOSING_PATTERNS) > 0) return 'closing';
    if (countMatches(textCorpus, QUOTE_PATTERNS) > 0) return 'quote';
    if (countMatches(textCorpus, AGENDA_PATTERNS) > 0) return 'agenda';
    if (countMatches(textCorpus, SECTION_PATTERNS) > 0 && counts.title >= 1 && counts.body <= 1) return 'section';

    if (counts.chart > 0) return 'chart';
    if (counts.table > 0) return 'table';
    if (counts.kpi_value >= 2) return 'kpi';
    if (counts.step_label >= 3 || hasHorizontalSequence(relevantShapes.filter(shape => shape.role === 'step_label'), 3)) {
        return 'process';
    }

    const bodyShapes = relevantShapes.filter(shape => shape.role === 'body' || shape.role === 'step_desc');
    if (bodyShapes.length >= 3 && hasHorizontalSequence(bodyShapes, 3)) return 'process';
    if (counts.image >= 6 && counts.body <= 1 && counts.chart === 0 && counts.table === 0) return 'library';
    if (hasTwoColumnBody(relevantShapes)) return 'comparison';
    if (counts.title >= 1 && counts.body === 0 && counts.subtitle >= 1) {
        return counts.image > 0 ? 'cover' : 'cover';
    }
    if (counts.title >= 1 && counts.body === 0 && counts.image > 0) return 'cover';
    if (counts.image > 0 && counts.body <= 1 && counts.chart === 0 && counts.table === 0) return 'image';
    if (counts.body >= 1 || counts.title >= 1) return 'content';

    return 'unknown';
}

export function inferSlideWarningFlags(
    shapes: ShapeEntry[],
    family: SlideSemanticFamily = inferSlideSemanticFamily(shapes),
): SlideWarningFlag[] {
    const relevantShapes = getNonDecorativeShapes(shapes);
    const counts = countRoles(relevantShapes);
    const textCorpus = getTextCorpus(relevantShapes);
    const warnings = new Set<SlideWarningFlag>();

    if (countMatches(textCorpus, STYLE_GUIDE_PATTERNS) >= 2) {
        warnings.add('possible-style-guide');
    }

    if (family === 'library' || (counts.image >= 8 && counts.body <= 1)) {
        warnings.add('possible-component-library');
    }

    if (counts.image > 0 && (family === 'cover' || family === 'image' || family === 'library')) {
        warnings.add('image-dependent');
    }

    return [...warnings];
}

export function buildStructuralSignature(shapes: ShapeEntry[]): string {
    const relevantShapes = getNonDecorativeShapes(shapes);
    const counts = countRoles(relevantShapes);
    const family = inferSlideSemanticFamily(relevantShapes);
    const warnings = inferSlideWarningFlags(relevantShapes, family).sort().join(',');
    const twoColumn = hasTwoColumnBody(relevantShapes) ? 1 : 0;
    const processBodies = hasHorizontalSequence(
        relevantShapes.filter(shape => shape.role === 'body' || shape.role === 'step_label' || shape.role === 'step_desc'),
        3,
    ) ? 1 : 0;

    return [
        `family:${family}`,
        `title:${counts.title}`,
        `subtitle:${counts.subtitle}`,
        `body:${counts.body}`,
        `kpi:${counts.kpi_value}`,
        `step:${counts.step_label}`,
        `image:${counts.image}`,
        `chart:${counts.chart}`,
        `table:${counts.table}`,
        `two-column:${twoColumn}`,
        `horizontal-seq:${processBodies}`,
        `warnings:${warnings}`,
    ].join('|');
}

export function buildSlideTypeGroupingKey(layoutName: string, shapes: ShapeEntry[]): string {
    const normalizedLayout = (layoutName || 'unknown').trim().toLowerCase();
    return `${normalizedLayout}::${buildStructuralSignature(shapes)}`;
}

export function scoreRepresentativeSlide(shapes: ShapeEntry[]): number {
    const relevantShapes = getNonDecorativeShapes(shapes);
    const family = inferSlideSemanticFamily(relevantShapes);
    const warnings = inferSlideWarningFlags(relevantShapes, family);
    const counts = countRoles(relevantShapes);

    let score = relevantShapes.length * 10;
    score += counts.title * 5;
    score += counts.body * 3;
    score += counts.kpi_value * 4;
    score += counts.step_label * 4;

    if (family === 'comparison' || family === 'process' || family === 'kpi' || family === 'chart' || family === 'table') {
        score += 12;
    }

    if (warnings.includes('possible-style-guide')) score -= 40;
    if (warnings.includes('possible-component-library')) score -= 15;

    const textCorpus = getTextCorpus(relevantShapes);
    const placeholderHits = countMatches(textCorpus, PLACEHOLDER_PATTERNS);
    score -= placeholderHits * 2;

    return score;
}

export function buildDefaultUseWhen(
    family: SlideSemanticFamily,
    warnings: SlideWarningFlag[] = [],
): string | undefined {
    if (warnings.includes('possible-style-guide')) {
        return 'Use only when you genuinely want to show style-guide, rule, or library content.';
    }

    switch (family) {
        case 'cover':
            return 'Opening slide for title, context, and first impression.';
        case 'section':
            return 'Chapter divider or dramaturgical transition between topic blocks.';
        case 'agenda':
            return 'Agenda, table of contents, or navigation slide at the start.';
        case 'comparison':
            return 'Cleanly contrast two options, perspectives, or before/after states.';
        case 'process':
            return 'Visualize a flow, roadmap, steps, or handovers of responsibility.';
        case 'kpi':
            return 'Highlight a few central metrics or status values concisely.';
        case 'chart':
            return 'Support a data trend or comparison with a chart.';
        case 'table':
            return 'Present structured detail data, actions, or lists as a table.';
        case 'image':
            return 'Use only when suitable real image material is available.';
        case 'closing':
            return 'Closing, contact, call to action, or final message at the end.';
        case 'library':
            return 'Use for icon, building-block, or component overviews, not as a standard content slide.';
        case 'quote':
            return 'Stage a striking quote or strong statement in isolation.';
        case 'content':
            return 'For structured content delivery when no more specialized slide type fits.';
        default:
            return undefined;
    }
}
