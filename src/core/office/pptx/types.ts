/**
 * Types for the PPTX generation pipeline (ADR-046).
 *
 * Two modes:
 * 1. Template mode: clone slides from .pptx, manipulate shapes via pptx-automizer
 * 2. Adhoc mode: generate slides from scratch via PptxGenJS
 */

/* ------------------------------------------------------------------ */
/*  Slide input (what the LLM sends)                                   */
/* ------------------------------------------------------------------ */

/** A single slide in a create_pptx call. */
export type SlideInput = TemplateSlideInput | AdhocSlideInput;

/** Template mode: clone a slide from a .pptx and adapt content. */
export interface TemplateSlideInput {
    /** 1-based slide number in the template to clone. */
    source_slide: number;
    /**
     * Content to inject into named shapes. Keys = shape names from catalog.
     * Plain string -> setText(). ContentValue object -> rich content dispatch.
     * For duplicate shape names, use "ShapeName#N" (0-based index).
     */
    content?: Record<string, string | ContentValue>;
    /** Shape names to remove (content-adaptive layout). */
    remove?: string[];
    /** PptxGenJS elements to generate on the cloned slide (hybrid mode). */
    generate?: GenerateElement[];
    /** Speaker notes for this slide. */
    notes?: string;
}

/** Adhoc mode: generate a slide from HTML via PptxGenJS bridge. */
export interface AdhocSlideInput {
    /** Annotated HTML (1280x720 canvas, data-object-type attributes). */
    html: string;
    /** Structured chart data referenced by data-chart-index in HTML. */
    charts?: ChartInput[];
    /** Structured table data referenced by data-table-index in HTML. */
    tables?: TableInput[];
    /** Speaker notes for this slide. */
    notes?: string;
}

/** Chart data for adhoc slides. */
export interface ChartInput {
    type: 'bar' | 'pie' | 'line';
    title?: string;
    categories: string[];
    series: Array<{
        name: string;
        values: number[];
        color?: string;
    }>;
}

/** Table data for adhoc slides. */
export interface TableInput {
    headers?: string[];
    rows?: (string | number | null)[][];
    style?: {
        headerColor?: string;
        headerTextColor?: string;
        zebraColor?: string;
    };
}

/* ------------------------------------------------------------------ */
/*  Rich content values (discriminated union)                          */
/* ------------------------------------------------------------------ */

/** Polymorphic content value for template shapes. Discriminator: `type`. */
export type ContentValue =
    | StyledTextContent
    | HtmlTextContent
    | ReplaceTextContent
    | ChartContent
    | TableContent
    | ImageContent
    | PositionContent
    | HyperlinkContent
    | RotateContent
    | DuotoneContent;

/* -- Text content types ------------------------------------------- */

/** Formatted text with runs (bold, italic, color, size, bullets). */
export interface StyledTextContent {
    type: 'styled_text';
    paragraphs: SimpleParagraph[];
}

export interface SimpleParagraph {
    runs: SimpleRun[];
    /** Bullet character (e.g. "-", "1.", "a)"). Omit for no bullet. */
    bullet?: string;
    /** Indentation level (0-based). */
    level?: number;
    /** Horizontal alignment. */
    align?: 'left' | 'center' | 'right';
}

export interface SimpleRun {
    text: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    superscript?: boolean;
    subscript?: boolean;
    /** Font size in pt. */
    size?: number;
    /** Hex color without # (e.g. "FF0000"). */
    color?: string;
    /** Font family name. */
    font?: string;
}

/**
 * HTML to PowerPoint text conversion.
 * Uses pptx-automizer's htmlToMultiText() to parse HTML into
 * formatted paragraphs with bold, italic, underline, lists, etc.
 */
export interface HtmlTextContent {
    type: 'html_text';
    /** HTML string (supports: b, i, u, br, ul/ol/li, p, span with style). */
    html: string;
}

/**
 * Token-based text replacement preserving original formatting.
 * Replaces specific text tokens while keeping the shape's original
 * font, size, color, and paragraph structure intact.
 */
export interface ReplaceTextContent {
    type: 'replace_text';
    /** Array of find-and-replace pairs. */
    replacements: Array<{
        /** Text to find in the shape. */
        replace: string;
        /** Replacement: plain string or styled runs. */
        by: string | Array<{
            text: string;
            bold?: boolean;
            italic?: boolean;
            color?: string;
            size?: number;
        }>;
    }>;
    /** Opening tag for template tokens (e.g. "{{"). Default: none. */
    opening_tag?: string;
    /** Closing tag for template tokens (e.g. "}}"). Default: none. */
    closing_tag?: string;
}

/* -- Chart content type ------------------------------------------- */

/** Chart data to replace an existing chart shape. */
export interface ChartContent {
    type: 'chart';
    series: Array<{
        name: string;
        values: number[];
        color?: string;
    }>;
    categories: string[];
    /**
     * Chart data method. Default: 'standard' (works for bar, line, pie, doughnut, area).
     * Use 'scatter' for XY scatter plots, 'bubble' for bubble charts,
     * 'combo' for combined chart types, 'extended' for chartEx format.
     */
    chart_type?: 'standard' | 'scatter' | 'bubble' | 'combo' | 'vertical_lines' | 'extended';
    /** For scatter charts: point data per series (alternative to values). */
    scatter_points?: Array<Array<{ x: number; y: number }>>;
    /** For bubble charts: point data per series with sizes. */
    bubble_points?: Array<Array<{ x: number; y: number; size: number }>>;
    /** Set chart title text. */
    title?: string;
    /** Configure axis range. */
    axis_range?: {
        /** Which axis to configure (0 = primary, 1 = secondary). Default: 0. */
        axis_index?: number;
        min?: number;
        max?: number;
        major_unit?: number;
        minor_unit?: number;
        /** Number format code (e.g. "#,##0", "0%"). */
        format_code?: string;
    };
    /** Configure data labels on chart series. */
    data_labels?: {
        show_value?: boolean;
        show_category?: boolean;
        show_series?: boolean;
        show_percent?: boolean;
        show_bubble_size?: boolean;
        show_leader_lines?: boolean;
        show_legend_key?: boolean;
        /** Label position. */
        position?: 'bestFit' | 'b' | 'ctr' | 'inBase' | 'inEnd' | 'l' | 'outEnd' | 'r' | 't';
        /** Label fill color (hex without #). */
        fill_color?: string;
    };
    /** Legend configuration. */
    legend?: 'remove' | 'minimize' | {
        /** Legend position in pixels on 1280x720 canvas. */
        x: number; y: number; w: number; h: number;
    };
    /** Plot area position in pixels on 1280x720 canvas. */
    plot_area?: { x: number; y: number; w: number; h: number };
    /** Mark the last column as total in waterfall charts. */
    waterfall_total_last?: boolean;
    /** 0-based index of the total column for waterfall charts. */
    waterfall_total_index?: number;
}

/* -- Table content type ------------------------------------------- */

/** Table data to replace an existing table shape. */
export interface TableContent {
    type: 'table';
    header?: TableRowData;
    body: TableRowData[];
    footer?: TableRowData;
    /** Auto-adjust table dimensions. */
    auto_adjust?: {
        /** Auto-adjust column widths to content. */
        width?: boolean;
        /** Auto-adjust row heights to content. */
        height?: boolean;
        /** Set fixed total width in EMU. */
        set_width?: number;
        /** Set fixed total height in EMU. */
        set_height?: number;
    };
}

/** A single row of table data with optional per-cell styling. */
export interface TableRowData {
    values: (string | number)[];
    /** Per-cell styles (null = no override). Must match values length. */
    styles?: (TableCellStyle | null)[];
}

/** Style overrides for a single table cell. */
export interface TableCellStyle {
    bold?: boolean;
    italic?: boolean;
    /** Font size in hundredths of a point (e.g. 1400 = 14pt). */
    size?: number;
    /** Text color (hex without #). */
    color?: string;
    /** Background color (hex without #). */
    background?: string;
}

/* -- Other content types ------------------------------------------ */

/** Image replacement via vault path. */
export interface ImageContent {
    type: 'image';
    /** Vault path to the image file. */
    vault_path: string;
}

/** Reposition/resize a shape (pixel coordinates on 1280x720 canvas). */
export interface PositionContent {
    type: 'position';
    x?: number;
    y?: number;
    w?: number;
    h?: number;
}

/** Add or set hyperlink on a shape. */
export interface HyperlinkContent {
    type: 'hyperlink';
    /** URL or slide number target. */
    target: string | number;
    /** Is this an external URL (true) or internal slide link (false)? Default: true. */
    external?: boolean;
}

/** Rotate a shape by degrees. */
export interface RotateContent {
    type: 'rotate';
    /** Rotation angle in degrees (clockwise). */
    degrees: number;
}

/** Apply duotone effect to an image shape. */
export interface DuotoneContent {
    type: 'duotone';
    /** Color in hex without # (e.g. "4472C4"). */
    color?: string;
    /** Preset color name (e.g. "black", "white"). */
    preset_color?: string;
    /** Tint percentage (0-100). */
    tint?: number;
    /** Saturation modification percentage. */
    saturation_mod?: number;
}

/* ------------------------------------------------------------------ */
/*  Generate elements (PptxGenJS hybrid on template slides)            */
/* ------------------------------------------------------------------ */

/** Element to generate on a cloned template slide via PptxGenJS. */
export type GenerateElement =
    | GenerateTextElement
    | GenerateShapeElement
    | GenerateChartElement
    | GenerateTableElement
    | GenerateImageElement;

interface GenerateBase {
    /** Position/size in pixels on 1280x720 canvas. */
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface GenerateTextElement extends GenerateBase {
    gen_type: 'text';
    text: string;
    fontSize?: number;
    bold?: boolean;
    color?: string;
    align?: 'left' | 'center' | 'right';
    fontFace?: string;
}

export interface GenerateShapeElement extends GenerateBase {
    gen_type: 'shape';
    shape: 'rect' | 'roundRect' | 'ellipse' | 'line' | 'arrow' | 'chevron' | 'triangle';
    fill?: string;
    line?: { color?: string; width?: number };
    text?: string;
    fontSize?: number;
}

export interface GenerateChartElement extends GenerateBase {
    gen_type: 'chart';
    chartType: 'bar' | 'pie' | 'line' | 'doughnut' | 'area';
    categories: string[];
    series: Array<{ name: string; values: number[]; color?: string }>;
    title?: string;
}

export interface GenerateTableElement extends GenerateBase {
    gen_type: 'table';
    headers?: string[];
    rows: (string | number | null)[][];
    headerColor?: string;
    headerTextColor?: string;
}

export interface GenerateImageElement extends GenerateBase {
    gen_type: 'image';
    vault_path: string;
}

/* ------------------------------------------------------------------ */
/*  Template catalog                                                   */
/* ------------------------------------------------------------------ */

/** Catalog describing available layouts in a template. */
export interface TemplateCatalog {
    /** Human-readable template name (e.g. "Acme Corporate"). */
    name: string;
    /** Template version or date. */
    version: string;
    /** Slide dimensions in pixels (default 1280x720). */
    slide_size: { width: number; height: number };
    /** Available layouts indexed by slide number. Used by TemplateEngine for auto-remove/auto-upgrade. */
    layouts: Record<number, LayoutEntry>;
    /** Slide types grouped by PowerPoint layout name (ADR-046). */
    slide_types: SlideType[];
    /** SHA-256 hash of the source .pptx file (for stale detection). */
    template_hash?: string;
    /** How many slides were analyzed during ingestion. */
    analyzed_slides?: number;
    /** Total number of slides in the source template. */
    total_slides?: number;
}

/** A single layout (slide) in the template catalog. */
export interface LayoutEntry {
    /** Human-readable layout name (e.g. "title-dark", "kpi-3"). */
    name: string;
    /** What this layout is for. */
    description: string;
    /** Narrative arc phase: hook, build, turn, resolution, echo. */
    narrative_phase?: string;
    /** Named shapes available for content injection. */
    shapes: ShapeEntry[];
}

/** A shape within a layout that can receive content. */
export interface ShapeEntry {
    /** Shape name (from PowerPoint Selection Pane / pptx-automizer). */
    name: string;
    /** What kind of content this shape expects. */
    role: 'title' | 'subtitle' | 'body' | 'kpi_value' | 'kpi_label' | 'step_label' | 'step_desc' | 'image' | 'chart' | 'table' | 'decorative';
    /** What type of pptx-automizer content operation this shape supports. */
    content_type: 'text' | 'chart' | 'table' | 'image';
    /** Max character count that fits without overflow (text shapes only). */
    max_chars?: number;
    /** Whether this shape can be removed for content-adaptive layouts. */
    removable?: boolean;
    /** 0-based index for duplicate shape names on the same slide. */
    duplicate_index?: number;
    /** Position and dimensions in pixels (1280x720 canvas). */
    dimensions?: { x: number; y: number; w: number; h: number };
    /** Sample text from the template shape (first 100 chars, for fallback resolution). */
    sample_text?: string;
    /** Specific function beyond the generic role (e.g. chapter number on section dividers). */
    special_role?: 'section_number';
    /** Font info extracted from the template shape's first text run. */
    font_info?: {
        font_face?: string;
        font_size?: number;
        is_bold?: boolean;
        color?: string;
        alignment?: string;
    };
}

/* ------------------------------------------------------------------ */
/*  Slide Type Catalog (ADR-046: Direct Template Mode)                 */
/* ------------------------------------------------------------------ */

/**
 * A slide type = a group of template slides sharing the same PowerPoint layout name.
 * The agent picks a representative slide number and addresses shapes by their physical names.
 */
export interface SlideType {
    /** Slug generated from the PowerPoint layout name (e.g. "titelfolie", "kpi-folie"). */
    id: string;
    /** Original PowerPoint layout name (e.g. "Titelfolie", "Inhalt"). */
    layout_name: string;
    /** Best slide to clone (has the most non-decorative shapes). */
    representative_slide: number;
    /** Other slides with the same layout (usable as alternates). */
    alternate_slides: number[];
    /** Auto-generated description from shape roles. */
    description: string;
    /** Template-agnostic semantic family inferred from structure and placeholder signals. */
    semantic_family?: SlideSemanticFamily;
    /** Non-decorative shapes available for content injection. */
    shapes: SlideTypeShape[];
    /** What the slide looks like visually (Phase 2: vision enrichment). */
    visual_description?: string;
    /** When to use this slide type (Phase 2: vision enrichment). */
    use_when?: string;
    /** Generic caveats for layout selection. */
    warning_flags?: SlideWarningFlag[];
}

/** A shape within a SlideType that can receive content. */
export interface SlideTypeShape {
    /** Physical shape name — use directly as content key in create_pptx. */
    name: string;
    /** Semantic role. */
    role: ShapeEntry['role'];
    /** Content type supported by pptx-automizer. */
    content_type: ShapeEntry['content_type'];
    /** Shape must be filled (true) or will auto-disappear if empty (false). */
    required: boolean;
    /** Max character count that fits without overflow (text shapes only). */
    max_chars?: number;
    /** 0-based index for duplicate shape names. If > 0: use "ShapeName#N" as key. */
    duplicate_index?: number;
    /** Position on slide derived from x,y,w,h (e.g. "oben volle Breite", "linke Spalte"). */
    position_hint?: string;
    /** Sample text from the template placeholder — reveals intended purpose. */
    sample_text?: string;
    /** Functional group label (shared by shapes that form one visual cluster). */
    group_hint?: string;
    /** Semantic description: what this shape IS and HOW to use it (Phase 2: vision enrichment). */
    semantic_hint?: string;
    /** Specific function beyond the generic role (e.g. chapter number on section dividers). */
    special_role?: 'section_number';
    /** Machine-readable group ID for shapes that must be removed/filled as a unit. */
    group_id?: string;
}

/** Template-agnostic semantic family inferred during ingestion. */
export type SlideSemanticFamily =
    | 'cover'
    | 'section'
    | 'agenda'
    | 'content'
    | 'comparison'
    | 'process'
    | 'kpi'
    | 'chart'
    | 'table'
    | 'image'
    | 'closing'
    | 'library'
    | 'quote'
    | 'unknown';

/** Warnings helping the agent avoid semantically wrong layout choices. */
export type SlideWarningFlag =
    | 'possible-style-guide'
    | 'possible-component-library'
    | 'image-dependent';

/* ------------------------------------------------------------------ */
/*  Build result                                                       */
/* ------------------------------------------------------------------ */

/** Result of building a presentation. */
export interface PptxBuildResult {
    /** The generated PPTX as ArrayBuffer (ready for writeBinaryToVault). */
    buffer: ArrayBuffer;
    /** Number of slides in the output. */
    slideCount: number;
    /** Warnings generated during build. */
    warnings: string[];
}

/* ------------------------------------------------------------------ */
/*  Deck Plan (plan_presentation output, ADR-048)                      */
/* ------------------------------------------------------------------ */

/** Complete deck plan produced by plan_presentation tool. */
export interface DeckPlan {
    /** Presentation title. */
    title: string;
    /** Storytelling framework (SCR, SCQA, Pyramid, DataStory, StatusReport). */
    narrative_framework: string;
    /** Speaker or Reading deck. */
    deck_mode: 'speaker' | 'reading';
    /** Vault path of the source note (if provided). */
    source_path?: string;
    /** Planned slides in presentation order. */
    slides: PlannedSlide[];
}

/** A single planned slide with full content for all shapes. */
export interface PlannedSlide {
    /** 1-based position in the output presentation. */
    position: number;
    /** Template slide number to clone. */
    source_slide: number;
    /** Slide type ID from the catalog (e.g. "kpi-folie"). */
    slide_type_id: string;
    /** Narrative purpose (e.g. "Hook: Bold opening claim"). */
    purpose: string;
    /** The ONE key message of this slide. */
    key_message: string;
    /** Content for shapes. Keys = exact shape names from catalog. */
    content: Record<string, string | ContentValue>;
    /** Shapes to remove (content-adaptive layout). */
    remove?: string[];
    /** Speaker notes. */
    notes?: string;
}

/* ------------------------------------------------------------------ */
/*  Type guards                                                        */
/* ------------------------------------------------------------------ */

export function isTemplateSlide(slide: SlideInput): slide is TemplateSlideInput {
    return 'source_slide' in slide && typeof slide.source_slide === 'number';
}

export function isAdhocSlide(slide: SlideInput): slide is AdhocSlideInput {
    return 'html' in slide && typeof slide.html === 'string';
}

export function isContentValue(value: string | ContentValue): value is ContentValue {
    return typeof value === 'object' && value !== null && 'type' in value;
}
