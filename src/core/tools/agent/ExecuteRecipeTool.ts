/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-template-expressions, @typescript-eslint/unbound-method -- File-level disable: interacts with external SDK / JSON / Obsidian internals where untyped 'any' values are unavoidable. Inputs are validated at boundaries via type guards or schema checks where security-relevant. */
/**
 * ExecuteRecipeTool — Recipe Shell (PAS-1.5, ADR-109)
 *
 * Executes pre-defined shell recipes using child_process.spawn with shell: false.
 * NO arbitrary shell commands. NO shell expansion.
 *
 * Security (7 layers):
 *   1. Master toggle (recipes.enabled)
 *   2. Per-recipe toggle (recipeToggles)
 *   3. Parameter validation (type, length, charset, path confinement)
 *   4. No shell expansion (spawn with args array)
 *   5. Pipeline approval (isWriteOperation = true)
 *   6. Process confinement (cwd=vault, timeout, output limit, SIGKILL)
 *   7. Audit trail (OperationLogger)
 */

import { spawnAllowed } from '../../security/spawnAllowlist';
import { BaseTool } from '../BaseTool';
import type { ToolDefinition, ToolExecutionContext } from '../types';
import type ObsidianAgentPlugin from '../../../main';
import { findRecipe, BUILT_IN_RECIPES, materializeCustomRecipes } from './recipeRegistry';
import { validateRecipeParams } from './recipeValidator';
import { buildSubprocessEnv } from '../../subprocess/buildSubprocessEnv';

/** Resolve binary to absolute path via 'which' (macOS/Linux) or 'where' (Windows) */
async function resolveBinary(name: string): Promise<string | null> {
    const cmd = process.platform === 'win32' ? 'where' : 'which';

    return new Promise((resolve) => {
        const child = spawnAllowed(cmd, [name], {
            timeout: 5_000,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        // stdio is ['ignore', 'pipe', 'pipe'], so child.stdout cannot be null.
        child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
        child.on('close', (code: number | null) => {
            if (code === 0 && stdout.trim()) {
                resolve(stdout.trim().split('\n')[0]); // First result
            } else {
                resolve(null);
            }
        });
        child.on('error', () => resolve(null));
    });
}

export class ExecuteRecipeTool extends BaseTool<'execute_recipe'> {
    readonly name = 'execute_recipe' as const;
    readonly isWriteOperation = true;

    constructor(plugin: ObsidianAgentPlugin) {
        super(plugin);
    }

    getDefinition(): ToolDefinition {
        // Build available recipes list for description. FEAT-30-07: includes
        // the user's (validated) custom recipes, otherwise the model would
        // never call them.
        const custom = materializeCustomRecipes(this.plugin.settings.recipes?.customRecipes);
        const recipeList = [...BUILT_IN_RECIPES, ...custom].map((r) => `${r.id}: ${r.description}`).join('; ');

        return {
            name: 'execute_recipe',
            description:
                'Execute a pre-defined recipe for external tools like Pandoc. ' +
                'Recipes are validated shell commands that run without shell expansion. ' +
                `Available recipes: ${recipeList}. ` +
                'Use check-dependency first to verify that a required program is installed.',
            input_schema: {
                type: 'object',
                properties: {
                    recipe_id: {
                        type: 'string',
                        description:
                            'The recipe ID to execute (e.g., "pandoc-pdf", "pandoc-docx", "check-dependency").',
                    },
                    params: {
                        type: 'object',
                        description:
                            'Parameters for the recipe. Keys are parameter names, values are strings. ' +
                            'Example: { "input": "notes/report.md", "output": "exports/report.pdf" }',
                    },
                },
                required: ['recipe_id', 'params'],
            },
        };
    }

    async execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<void> {
        const { callbacks } = context;
        const recipeId = (input.recipe_id as string ?? '').trim();
        const params = (input.params as Record<string, unknown>) ?? {};

        // 1. Master toggle check
        if (!this.plugin.settings.recipes?.enabled) {
            callbacks.pushToolResult(
                this.formatError(new Error(
                    'Recipe execution is disabled. Enable it in Settings > Customize > Recipes.',
                )),
            );
            return;
        }

        // 2. Find recipe (custom recipes are re-validated + compiled here;
        //    invalid stored entries are dropped by materializeCustomRecipes)
        const customRecipes = materializeCustomRecipes(this.plugin.settings.recipes?.customRecipes);
        const recipe = findRecipe(recipeId, customRecipes);
        if (!recipe) {
            const available = [...BUILT_IN_RECIPES, ...customRecipes].map((r) => r.id).join(', ');
            callbacks.pushToolResult(
                this.formatError(new Error(
                    `Unknown recipe: "${recipeId}". Available: ${available}`,
                )),
            );
            return;
        }

        // 3. Per-recipe toggle check
        const recipeToggles = this.plugin.settings.recipes?.recipeToggles ?? {};
        if (recipeToggles[recipeId] === false) {
            callbacks.pushToolResult(
                this.formatError(new Error(
                    `Recipe "${recipeId}" is disabled. Enable it in Settings > Customize > Recipes.`,
                )),
            );
            return;
        }

        // 4. Get vault root
        const adapter = this.app.vault.adapter;
        const vaultRoot: string = (adapter as import('obsidian').FileSystemAdapter).basePath ?? (adapter as import('obsidian').FileSystemAdapter).getBasePath?.() ?? '';
        if (!vaultRoot) {
            callbacks.pushToolResult(
                this.formatError(new Error('Cannot determine vault root path')),
            );
            return;
        }

        // 5. Validate parameters
        const errors = validateRecipeParams(recipe.parameters, params, vaultRoot);
        if (errors.length > 0) {
            const msgs = errors.map((e) => `${e.parameter}: ${e.message}`).join('; ');
            callbacks.pushToolResult(
                this.formatError(new Error(`Parameter validation failed: ${msgs}`)),
            );
            return;
        }

        // 6. Resolve binary to absolute path (S-06, S-13: no PATH hijacking)
        const binaryPath = await resolveBinary(recipe.binary);
        if (!binaryPath) {
            callbacks.pushToolResult(
                this.formatError(new Error(
                    `"${recipe.binary}" is not installed on this system. ` +
                    `Install it first, then try again.`,
                )),
            );
            return;
        }

        // 7. Build args from template
        const validatedParams: Record<string, string> = {};
        for (const param of recipe.parameters) {
            if (params[param.name] !== undefined) {
                validatedParams[param.name] = String(params[param.name]);
            }
        }

        const args = recipe.argsTemplate.map((tmpl) =>
            tmpl.replace(/\{\{(\w+)\}\}/g, (_, name) => validatedParams[name] ?? ''),
        );

        // 7b. AUDIT 2026-07-26 M-3 (CWE-863): govern the paths that are ACTUALLY
        // handed to the process.
        //
        // execute_recipe sat entirely outside the path governance: its vault
        // paths live inside a nested `params` object, and PATH_INPUT_KEYS only
        // declares flat top-level keys, so validatePaths took its
        // `if (!path) return allowed` fallback and IgnoreService never ran.
        //
        // Checking `params[...]` would not be enough either. The token the
        // binary receives is the SUBSTITUTED template entry, and a template may
        // wrap the value (`-o{{output}}`, `--from={{format}}`). The composed
        // token is what reaches the filesystem, so the composed token is what
        // gets checked -- and checking here, after every await and immediately
        // before the spawn, also closes the window between the pipeline's own
        // check and this one.
        const ignoreService = this.plugin.ignoreService;
        for (const param of recipe.parameters) {
            if (param.type !== 'vault-file' && param.type !== 'vault-output') continue;
            const value = validatedParams[param.name];
            if (value === undefined || value === '') continue;
            const isWrite = param.type === 'vault-output';
            if (ignoreService.isIgnored(value) || (isWrite && ignoreService.isProtected(value))) {
                callbacks.pushToolResult(this.formatError(new Error(
                    `Recipe "${recipeId}" was refused: ${ignoreService.getDenialReason(value)}`,
                )));
                return;
            }
        }

        // 8. Spawn process (S-04: shell: false)
        try {
            const result = await this.spawnProcess(binaryPath, args, vaultRoot, recipe);

            if (result.exitCode !== 0) {
                const stderr = result.stderr.trim();
                callbacks.pushToolResult(
                    this.formatError(new Error(
                        `Recipe "${recipeId}" failed (exit code ${result.exitCode}).` +
                        (stderr ? ` Error: ${stderr}` : ''),
                    )),
                );
                return;
            }

            // Success
            let output = result.stdout.trim();
            if (recipe.producesFile) {
                const outputParam = recipe.parameters.find((p) => p.type === 'vault-output');
                const outputPath = outputParam ? validatedParams[outputParam.name] : '';
                output = `Recipe "${recipe.name}" completed successfully.` +
                    (outputPath ? ` Output file: ${outputPath}` : '') +
                    (output ? `\n\nProcess output:\n${output}` : '');
            }

            callbacks.pushToolResult(this.formatSuccess(output || `Recipe "${recipe.name}" completed.`));
            callbacks.log(`Recipe executed: ${recipeId} (${recipe.binary})`);
        } catch (error) {
            callbacks.pushToolResult(this.formatError(error));
            await callbacks.handleError('execute_recipe', error);
        }
    }

    /**
     * Spawn a child process with full confinement.
     * S-04: shell: false
     * S-05: Minimal env vars
     * S-06: cwd = vault root
     * S-09: Output capped, SIGKILL after timeout
     */
    private spawnProcess(
        binaryPath: string,
        args: string[],
        vaultRoot: string,
        recipe: { timeout: number; maxOutputSize: number },
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        return new Promise((resolve, reject) => {
            const child = spawnAllowed(binaryPath, args, {
                cwd: vaultRoot,
                timeout: recipe.timeout,
                env: buildSubprocessEnv(),
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });

            let stdout = '';
            let stderr = '';
            let stdoutSize = 0;
            let stderrSize = 0;
            const maxSize = recipe.maxOutputSize;

            // stdio is ['ignore', 'pipe', 'pipe'], so stdout/stderr cannot be null.
            child.stdout?.on('data', (data: Buffer) => {
                if (stdoutSize < maxSize) {
                    const chunk = data.toString();
                    stdout += chunk;
                    stdoutSize += chunk.length;
                    if (stdoutSize >= maxSize) {
                        stdout = stdout.slice(0, maxSize) + '\n... [output truncated]';
                    }
                }
            });

            child.stderr?.on('data', (data: Buffer) => {
                if (stderrSize < maxSize) {
                    const chunk = data.toString();
                    stderr += chunk;
                    stderrSize += chunk.length;
                    if (stderrSize >= maxSize) {
                        stderr = stderr.slice(0, maxSize) + '\n... [output truncated]';
                    }
                }
            });

            // SIGKILL fallback if process doesn't exit after timeout
            const killTimer = window.setTimeout(() => {
                try { child.kill('SIGKILL'); } catch { /* process already exited */ }
            }, recipe.timeout + 5_000);

            child.on('close', (code: number | null) => {
                window.clearTimeout(killTimer);
                resolve({
                    exitCode: code ?? 1,
                    stdout,
                    stderr,
                });
            });

            child.on('error', (err: Error) => {
                window.clearTimeout(killTimer);
                reject(err);
            });
        });
    }
}

/* eslint-enable -- end of file-level disable for boundary code (SDK/JSON/Obsidian internals) */
