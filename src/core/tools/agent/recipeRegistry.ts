/**
 * Recipe Registry — Built-in recipe definitions for execute_recipe (PAS-1.5)
 *
 * Recipes are pre-defined, validated shell commands that the agent can execute.
 * They use child_process.spawn with shell: false — NO shell expansion.
 *
 * Users can add custom recipes via settings; those are validated on load
 * (validateStoredRecipe / materializeCustomRecipes, FEAT-30-07).
 */

import { isPatternComplex } from '../../utils/safeRegex';

export interface RecipeParameter {
    name: string;
    type: 'vault-file' | 'vault-output' | 'enum' | 'safe-string' | 'number';
    required: boolean;
    description: string;
    /** Allowed values for enum type */
    enumValues?: string[];
    /** Validation pattern for safe-string type */
    pattern?: RegExp;
    /** Min value for number type */
    min?: number;
    /** Max value for number type */
    max?: number;
}

export interface Recipe {
    id: string;
    name: string;
    description: string;
    /** Binary name (resolved via which/where to absolute path at runtime) */
    binary: string;
    /** Argument template array. Use {{paramName}} for substitution. */
    argsTemplate: string[];
    parameters: RecipeParameter[];
    /** Working directory — always vault root */
    cwd: 'vault-root';
    /** Max execution time in ms */
    timeout: number;
    /** Max stdout+stderr size in bytes */
    maxOutputSize: number;
    /** Whether this recipe produces an output file */
    producesFile: boolean;
}

export const BUILT_IN_RECIPES: Recipe[] = [
    {
        id: 'pandoc-pdf',
        name: 'Pandoc PDF Export',
        description: 'Convert a markdown file to PDF using Pandoc with XeLaTeX engine',
        binary: 'pandoc',
        // `--` ends option parsing: every token after it is a positional
        // (defense-in-depth against arg-injection, AUDIT 2026-07-22 H-1).
        // Fixed flags stay before `--`; substituted paths come after.
        argsTemplate: ['--pdf-engine=xelatex', '-o', '{{output}}', '--', '{{input}}'],
        parameters: [
            {
                name: 'input',
                type: 'vault-file',
                required: true,
                description: 'Input markdown file (relative to vault root)',
            },
            {
                name: 'output',
                type: 'vault-output',
                required: true,
                description: 'Output PDF file path (relative to vault root)',
            },
        ],
        cwd: 'vault-root',
        timeout: 120_000,
        maxOutputSize: 10_000,
        producesFile: true,
    },
    {
        id: 'pandoc-docx',
        name: 'Pandoc DOCX Export',
        description: 'Convert a markdown file to DOCX using Pandoc',
        binary: 'pandoc',
        // `--` ends option parsing (AUDIT 2026-07-22 H-1 defense-in-depth).
        argsTemplate: ['-o', '{{output}}', '--', '{{input}}'],
        parameters: [
            {
                name: 'input',
                type: 'vault-file',
                required: true,
                description: 'Input markdown file (relative to vault root)',
            },
            {
                name: 'output',
                type: 'vault-output',
                required: true,
                description: 'Output DOCX file path (relative to vault root)',
            },
        ],
        cwd: 'vault-root',
        timeout: 60_000,
        maxOutputSize: 10_000,
        producesFile: true,
    },
    {
        id: 'pandoc-convert',
        name: 'Pandoc Convert',
        description: 'Convert between document formats using Pandoc (format inferred from file extension)',
        binary: 'pandoc',
        // `--` ends option parsing (AUDIT 2026-07-22 H-1 defense-in-depth).
        argsTemplate: ['-o', '{{output}}', '--', '{{input}}'],
        parameters: [
            {
                name: 'input',
                type: 'vault-file',
                required: true,
                description: 'Input file (relative to vault root)',
            },
            {
                name: 'output',
                type: 'vault-output',
                required: true,
                description: 'Output file path (relative to vault root)',
            },
        ],
        cwd: 'vault-root',
        timeout: 60_000,
        maxOutputSize: 10_000,
        producesFile: true,
    },
    {
        id: 'check-dependency',
        name: 'Check Dependency',
        description: 'Check if an external program is installed on the system',
        binary: process.platform === 'win32' ? 'where' : 'which',
        argsTemplate: ['{{program}}'],
        parameters: [
            {
                name: 'program',
                type: 'safe-string',
                required: true,
                description: 'Program name to check',
                pattern: /^[a-zA-Z0-9._-]+$/,
            },
        ],
        cwd: 'vault-root',
        timeout: 5_000,
        maxOutputSize: 1_000,
        producesFile: false,
    },
];

/**
 * Find a recipe by ID in built-in + custom recipes.
 */
export function findRecipe(id: string, customRecipes: Recipe[] = []): Recipe | undefined {
    return BUILT_IN_RECIPES.find((r) => r.id === id)
        ?? customRecipes.find((r) => r.id === id);
}

// ─────────────────────────────────────────────────────────────────────────
// FEAT-30-07 Phase 3b: Custom-Recipes (persistierbar + load-validiert)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Persistierte Form eines Custom-Recipes (data.json). Identisch zu Recipe,
 * aber `pattern` ist ein String: RegExp ueberlebt JSON.stringify nicht
 * (wird zu {}). materializeCustomRecipes kompiliert beim Laden.
 */
export interface StoredRecipeParameter {
    name: string;
    type: RecipeParameter['type'];
    required: boolean;
    description: string;
    enumValues?: string[];
    /** Validation pattern for safe-string type, as SOURCE STRING. */
    pattern?: string;
    min?: number;
    max?: number;
}

export interface StoredRecipe {
    id: string;
    name: string;
    description: string;
    binary: string;
    argsTemplate: string[];
    parameters: StoredRecipeParameter[];
    cwd: 'vault-root';
    timeout: number;
    maxOutputSize: number;
    producesFile: boolean;
}

/**
 * Binaries, die Custom-Recipes verwenden duerfen. Bewusst ENGER als die
 * globale spawnAllowlist: `node`, `git` und `cloudflared` stehen dort fuer
 * interne Zwecke (Sandbox-Worker, Checkpoints, Tunnel) und waeren als
 * Recipe-Binary ein Arbitrary-Code-Execution-Vektor. Erweiterung ist eine
 * Sicherheitsentscheidung und braucht Review (wie spawnAllowlist selbst).
 */
export const CUSTOM_RECIPE_ALLOWED_BINARIES: readonly string[] = Object.freeze([
    'pandoc', 'soffice', 'libreoffice', 'which', 'where',
]);

const RECIPE_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const PARAM_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,30}$/;
const PLACEHOLDER_RE = /\{\{([^}]+)\}\}/g;
const PARAM_TYPES = new Set(['vault-file', 'vault-output', 'enum', 'safe-string', 'number']);
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CAP = 1_000_000;

export interface StoredRecipeValidation {
    ok: boolean;
    errors: string[];
}

/**
 * Load-Time-Validierung eines persistierten Custom-Recipes. Fail-closed:
 * jede Verletzung ist ein Fehler, ReDoS-verdaechtige Patterns werden
 * explizit ABGELEHNT statt still literal-escaped (der Autor soll es merken).
 */
export function validateStoredRecipe(raw: unknown): StoredRecipeValidation {
    const errors: string[] = [];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return { ok: false, errors: ['recipe must be an object'] };
    }
    const r = raw as Partial<StoredRecipe>;

    if (typeof r.id !== 'string' || !RECIPE_ID_RE.test(r.id)) {
        errors.push('id must match ^[a-z0-9][a-z0-9-]{1,40}$');
    } else if (BUILT_IN_RECIPES.some((b) => b.id === r.id)) {
        errors.push(`id "${r.id}" collides with a built-in recipe`);
    }
    if (typeof r.name !== 'string' || r.name.trim().length === 0 || r.name.length > 100) {
        errors.push('name must be a non-empty string (max 100 chars)');
    }
    if (typeof r.description !== 'string' || r.description.trim().length === 0 || r.description.length > 300) {
        errors.push('description must be a non-empty string (max 300 chars)');
    }
    if (typeof r.binary !== 'string' || !CUSTOM_RECIPE_ALLOWED_BINARIES.includes(r.binary)) {
        errors.push(`binary must be one of: ${CUSTOM_RECIPE_ALLOWED_BINARIES.join(', ')} (exact basename, no paths)`);
    }
    if (r.cwd !== 'vault-root') {
        errors.push("cwd must be 'vault-root'");
    }
    if (typeof r.timeout !== 'number' || !Number.isFinite(r.timeout) || r.timeout < MIN_TIMEOUT_MS || r.timeout > MAX_TIMEOUT_MS) {
        errors.push(`timeout must be ${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS} ms`);
    }
    if (typeof r.maxOutputSize !== 'number' || !Number.isFinite(r.maxOutputSize) || r.maxOutputSize < 100 || r.maxOutputSize > MAX_OUTPUT_CAP) {
        errors.push(`maxOutputSize must be 100..${MAX_OUTPUT_CAP} bytes`);
    }
    if (typeof r.producesFile !== 'boolean') {
        errors.push('producesFile must be a boolean');
    }

    const paramNames = new Set<string>();
    if (!Array.isArray(r.parameters) || r.parameters.length > 10) {
        errors.push('parameters must be an array (max 10 entries)');
    } else {
        for (const p of r.parameters) {
            if (typeof p !== 'object' || p === null) { errors.push('parameter entries must be objects'); continue; }
            if (typeof p.name !== 'string' || !PARAM_NAME_RE.test(p.name) || paramNames.has(p.name)) {
                errors.push(`parameter name "${String(p.name)}" invalid or duplicated`);
            } else {
                paramNames.add(p.name);
            }
            if (typeof p.type !== 'string' || !PARAM_TYPES.has(p.type)) {
                errors.push(`parameter "${String(p.name)}": unknown type "${String(p.type)}"`);
            }
            if (typeof p.required !== 'boolean') errors.push(`parameter "${String(p.name)}": required must be boolean`);
            if (typeof p.description !== 'string' || p.description.length > 200) {
                errors.push(`parameter "${String(p.name)}": description must be a string (max 200 chars)`);
            }
            if (p.type === 'enum' && (!Array.isArray(p.enumValues) || p.enumValues.length === 0
                || !p.enumValues.every((v) => typeof v === 'string' && v.length <= 100))) {
                errors.push(`parameter "${String(p.name)}": enum needs non-empty string enumValues`);
            }
            if (p.pattern !== undefined) {
                if (typeof p.pattern !== 'string' || p.pattern.length === 0 || p.pattern.length > 200) {
                    errors.push(`parameter "${String(p.name)}": pattern must be a short string`);
                } else {
                    // ReDoS-Heuristik aus utils/safeRegex (M-6-gehaertet).
                    if (isPatternComplex(p.pattern)) {
                        errors.push(`parameter "${String(p.name)}": pattern rejected (ReDoS-prone or too long)`);
                    } else {
                        try { new RegExp(p.pattern); } catch {
                            errors.push(`parameter "${String(p.name)}": pattern does not compile`);
                        }
                    }
                }
            }
            if ((p.min !== undefined && typeof p.min !== 'number') || (p.max !== undefined && typeof p.max !== 'number')) {
                errors.push(`parameter "${String(p.name)}": min/max must be numbers`);
            }
        }
    }

    if (Array.isArray(r.argsTemplate) && r.argsTemplate.length > 0 && r.argsTemplate.length <= 30
        && r.argsTemplate.every((a) => typeof a === 'string' && a.length <= 200)) {
        for (const arg of r.argsTemplate) {
            for (const m of arg.matchAll(PLACEHOLDER_RE)) {
                const ref = m[1];
                // Review-Finding: die Laufzeit-Substitution matcht nur
                // \{\{\w+\}\}; alles andere (Leerzeichen, Sonderzeichen)
                // wuerde die Validierung passieren, aber nie substituiert
                // und als Literal ans Binary gehen. Strikt ablehnen.
                if (!/^\w+$/.test(ref)) {
                    errors.push(`argsTemplate placeholder "{{${ref}}}" is malformed (use {{name}} without spaces)`);
                    continue;
                }
                if (!paramNames.has(ref)) {
                    errors.push(`argsTemplate references undeclared parameter "${ref}"`);
                }
            }
        }
    } else {
        errors.push('argsTemplate must be a non-empty string array (max 30 entries, 200 chars each)');
    }

    return { ok: errors.length === 0, errors };
}

/**
 * Kompiliert persistierte Custom-Recipes in die Laufzeitform. Ungueltige
 * Eintraege werden mit console.warn verworfen (Load-Pfad darf nie werfen).
 */
export function materializeCustomRecipes(stored: StoredRecipe[] | undefined): Recipe[] {
    if (!Array.isArray(stored)) return [];
    const out: Recipe[] = [];
    for (const s of stored) {
        const v = validateStoredRecipe(s);
        if (!v.ok) {
            console.warn(`[recipeRegistry] custom recipe "${String((s as { id?: unknown })?.id)}" dropped:`, v.errors);
            continue;
        }
        out.push({
            id: s.id,
            name: s.name,
            description: s.description,
            binary: s.binary,
            argsTemplate: [...s.argsTemplate],
            parameters: s.parameters.map((p): RecipeParameter => ({
                name: p.name,
                type: p.type,
                required: p.required,
                description: p.description,
                ...(p.enumValues ? { enumValues: [...p.enumValues] } : {}),
                ...(p.pattern ? { pattern: new RegExp(p.pattern) } : {}),
                ...(p.min !== undefined ? { min: p.min } : {}),
                ...(p.max !== undefined ? { max: p.max } : {}),
            })),
            cwd: 'vault-root',
            timeout: s.timeout,
            maxOutputSize: s.maxOutputSize,
            producesFile: s.producesFile,
        });
    }
    return out;
}
