/**
 * Recipe Validator — Parameter validation for execute_recipe (PAS-1.5)
 *
 * Defense-in-depth: validates all parameters BEFORE they reach child_process.spawn.
 * Even though spawn(shell: false) prevents shell expansion, we still reject
 * dangerous characters to prevent any future attack surface.
 *
 * Security checklist:
 * - S-01: Shell metacharacter rejection in ALL parameters
 * - S-02: Path traversal prevention (no .., no absolute paths, vault confinement)
 * - S-08: No dynamic regex (all patterns are compile-time)
 */

import * as path from 'path';
import type { RecipeParameter } from './recipeRegistry';

/**
 * Shell metacharacters that are forbidden in ALL parameter values.
 * Even with shell: false, we reject these as defense-in-depth.
 */
const SHELL_META = /[;&|`$(){}[\]<>\\!#~*?\n\r\0]/;

export interface ValidationError {
    parameter: string;
    message: string;
}

/**
 * Validate a single parameter value against its schema.
 * Returns null if valid, or an error message if invalid.
 */
export function validateParameter(
    param: RecipeParameter,
    value: unknown,
    vaultRoot: string,
): string | null {
    // Required check
    if (value === undefined || value === null || value === '') {
        if (param.required) return `Parameter "${param.name}" is required`;
        return null; // Optional and not provided — skip
    }

    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        return `Parameter "${param.name}" expected a primitive value`;
    }
    const strValue = String(value);

    // S-01: Shell metacharacter check for ALL parameter types
    if (SHELL_META.test(strValue)) {
        return `Forbidden characters in "${param.name}". Shell metacharacters are not allowed.`;
    }

    switch (param.type) {
        case 'vault-file':
        case 'vault-output': {
            // S-14 (AUDIT 2026-07-22 H-1): reject any path token that begins
            // with a dash. Even with shell:false, a value like
            // "--lua-filter=evil.lua" is substituted as a STANDALONE argv token
            // and pandoc (and most CLIs) interpret it as a flag, not a path --
            // an argument-injection RCE that escapes the sandbox. Path
            // parameters are never legitimately options, so a leading `-` is
            // always hostile. SHELL_META does not cover `-`/`=` by design
            // (they are valid in filenames), hence this dedicated guard.
            if (strValue.startsWith('-')) {
                return `Path "${param.name}" must not start with "-" (looks like a command-line option)`;
            }
            // S-02: No absolute paths
            if (path.isAbsolute(strValue)) {
                return `Absolute paths not allowed in "${param.name}"`;
            }
            // S-02: Resolve and check confinement
            const resolved = path.resolve(vaultRoot, strValue);
            const normalizedRoot = path.resolve(vaultRoot);
            if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
                return `Path "${param.name}" escapes vault root`;
            }
            // AUDIT 2026-07-26 M-3: the dot-segment rejection used to apply to
            // vault-file only. A vault-output path could therefore write into
            // `.obsidian/plugins/*/main.js` (code that runs on the next reload),
            // into `.vault-operator/data/skills/*/scripts/*.js` (code the agent
            // can then execute) or into `.trash`. An output path is the MORE
            // dangerous of the two, so it gets the same rule.
            if (strValue.split('/').some((seg) => seg.startsWith('.'))) {
                return `Hidden paths not allowed in "${param.name}"`;
            }
            return null;
        }

        case 'enum': {
            if (!param.enumValues || !param.enumValues.includes(strValue)) {
                const allowed = param.enumValues?.join(', ') ?? 'none';
                return `Invalid value for "${param.name}". Allowed: ${allowed}`;
            }
            return null;
        }

        case 'safe-string': {
            const pattern = param.pattern ?? /^[a-zA-Z0-9._\s-]+$/;
            if (!pattern.test(strValue)) {
                return `Invalid characters in "${param.name}"`;
            }
            if (strValue.length > 200) {
                return `Value for "${param.name}" exceeds maximum length (200)`;
            }
            return null;
        }

        case 'number': {
            const n = Number(strValue);
            if (isNaN(n)) {
                return `"${param.name}" must be a number`;
            }
            if (param.min !== undefined && n < param.min) {
                return `"${param.name}" is below minimum (${param.min})`;
            }
            if (param.max !== undefined && n > param.max) {
                return `"${param.name}" is above maximum (${param.max})`;
            }
            return null;
        }

        default:
            return `Unknown parameter type for "${param.name}"`;
    }
}

/**
 * Validate all parameters for a recipe.
 * Returns an array of validation errors (empty if all valid).
 */
export function validateRecipeParams(
    parameters: RecipeParameter[],
    input: Record<string, unknown>,
    vaultRoot: string,
): ValidationError[] {
    const errors: ValidationError[] = [];

    for (const param of parameters) {
        const error = validateParameter(param, input[param.name], vaultRoot);
        if (error) {
            errors.push({ parameter: param.name, message: error });
        }
    }

    // Check for unknown parameters (defense-in-depth: no extra params allowed)
    const knownNames = new Set(parameters.map((p) => p.name));
    for (const key of Object.keys(input)) {
        if (!knownNames.has(key)) {
            errors.push({ parameter: key, message: `Unknown parameter "${key}"` });
        }
    }

    return errors;
}
