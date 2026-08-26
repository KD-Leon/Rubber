/**
 * RunSkillScriptTool -- Generic executor for `scripts/{name}.js` inside a
 * self-authored skill folder. Replaces the previous `code_modules` /
 * `custom_*`-tool pattern (deprecated by FEAT-29-06 / ADR-126).
 *
 * Layout (FEAT-29-02 folder format):
 *   {agent-folder}/data/skills/{skill_name}/
 *     SKILL.md
 *     scripts/{script_name}.js   <-- this tool loads from here
 *
 * The script exports `async function execute(args) { ... }`. Return value
 * is JSON-serialized and pushed as tool_result.
 *
 * Path-traversal guard: skill_name and script_name are validated against an
 * alphanumeric-plus-dash whitelist before the path is joined. A malicious
 * `../` or `/` segment is rejected with a clear error.
 *
 * isWriteOperation=true because the script can mutate vault state, hit
 * external HTTP via the sandbox bridge, or write files. The approval gate
 * runs even for read-only scripts; that is the conservative default.
 */

import { BaseTool } from '../BaseTool';
import type { ToolDefinition, ToolExecutionContext } from '../types';
import type ObsidianAgentPlugin from '../../../main';
import { getSelfAuthoredSkillsDir } from '../../utils/agentFolder';
import { RunSkillScriptCache } from '../../sandbox/RunSkillScriptCache';
import { isSafePathSegment } from '../../utils/safePathName';
import { classifySkillScript, verdictReason } from '../../governance/skillScriptGuard';
import { sha256Hex } from '../../utils/sha256';
import { BUNDLED_SKILLS } from '../../../_generated/bundled-skills';
import { castGenerated } from '../../utils/runtime';
import { AstValidator } from '../../sandbox/AstValidator';

export class RunSkillScriptTool extends BaseTool<'run_skill_script'> {
    readonly name = 'run_skill_script' as const;
    // Scripts can mutate state, do HTTP, write files. Treat as write op so
    // the approval gate is conservative.
    readonly isWriteOperation = true;

    // FEAT-29-06 Task B: shared per-tool-instance cache. EsbuildWasm
    // compile is the expensive step (transform: ~100 ms for small scripts,
    // build: ~500-2000 ms for bundles with deps). Caching by source-hash
    // means a script that runs in a loop pays the bundler cost once.
    private readonly cache: RunSkillScriptCache;

    constructor(plugin: ObsidianAgentPlugin) {
        super(plugin);
        this.cache = new RunSkillScriptCache();
    }

    getDefinition(): ToolDefinition {
        return {
            name: 'run_skill_script',
            description:
                'Execute a JavaScript helper script that lives in a self-authored skill folder. '
                + 'Path: {agent-folder}/data/skills/{skill_name}/scripts/{script_name}.js. '
                + 'The script must export `async function execute(args)`; its return value is JSON-serialized '
                + 'back to the tool_result. Use this for deterministic, repeatable steps the agent should '
                + 'not have to hallucinate each time (data aggregation, API calls, format conversion).',
            input_schema: {
                type: 'object',
                properties: {
                    skill_name: {
                        type: 'string',
                        description: 'Folder name of the self-authored skill that owns the script.',
                    },
                    script_name: {
                        type: 'string',
                        description: 'File-name of the script inside scripts/, without the .js extension.',
                    },
                    args: {
                        type: 'object',
                        description: 'JSON-serializable arguments handed to the script\'s execute(args) function. Defaults to {}.',
                        additionalProperties: true,
                    },
                },
                required: ['skill_name', 'script_name'],
            },
        };
    }

    async execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<void> {
        const { callbacks } = context;
        const skillName = (input.skill_name as string ?? '').trim();
        const scriptName = (input.script_name as string ?? '').trim();
        const args = (input.args as Record<string, unknown> | undefined) ?? {};

        if (!skillName) {
            callbacks.pushToolResult(this.formatError(new Error('skill_name parameter is required')));
            return;
        }
        if (!scriptName) {
            callbacks.pushToolResult(this.formatError(new Error('script_name parameter is required')));
            return;
        }
        if (!isSafePathSegment(skillName)) {
            callbacks.pushToolResult(
                this.formatError(new Error(`invalid skill_name (path-traversal guard): ${JSON.stringify(skillName)}`)),
            );
            return;
        }
        if (!isSafePathSegment(scriptName)) {
            callbacks.pushToolResult(
                this.formatError(new Error(`invalid script_name (path-traversal guard): ${JSON.stringify(scriptName)}`)),
            );
            return;
        }

        const skillsDir = getSelfAuthoredSkillsDir(this.plugin);
        const scriptPath = `${skillsDir}/${skillName}/scripts/${scriptName}.js`;

        // Load script source
        let source: string;
        try {
            const adapter = this.plugin.app.vault.adapter;
            if (!(await adapter.exists(scriptPath))) {
                callbacks.pushToolResult(
                    this.formatError(new Error(`Script not found: ${scriptPath}`)),
                );
                return;
            }
            source = await adapter.read(scriptPath);
        } catch (e) {
            callbacks.pushToolResult(this.formatError(e));
            return;
        }

        // Content-hash grant (M-1 follow-up) TOCTOU pin: when the approval gate
        // cleared this call for a specific byte-state (context.approvedSandboxHash),
        // the bytes we are about to compile MUST still be those bytes. Sandboxed
        // code may write into skills/, so a concurrent script could otherwise
        // swap approved code for other code between the gate and here -- the exact
        // M-1 attack surface. We hash the SAME `source` we compile below, so there
        // is no gap inside the tool; the pin only rejects a change since approval.
        const approvedHash = context.approvedSandboxHash;
        if (typeof approvedHash === 'string' && sha256Hex(source) !== approvedHash) {
            callbacks.pushToolResult(this.formatError(new Error(
                `Refusing to run ${skillName}/scripts/${scriptName}.js: the script changed since it was `
                + 'approved -- its bytes no longer match what you allowed. Run it again to review and '
                + 'approve the new version.',
            )));
            return;
        }

        // AUDIT 2026-07-26 M-1: refuse bytes that are not the ones we shipped.
        //
        // The sandbox may write into skills/ (the deny zone exempts it so
        // skill-creator can work), so an overwritten script of a bundled skill
        // used to run under autoApproval.sandbox with no second prompt. This is
        // classified on `source` -- the string that is compiled a few lines
        // down -- not on a fresh read, so the verdict describes what runs.
        //
        // Only the tampered case is refused here. Ordinary user- and
        // agent-authored scripts stay runnable; the approval gate handles those.
        // A blanket ban would break the skill-creator flow the finding protects.
        let skillMd: string | null = null;
        try {
            const mdPath = `${skillsDir}/${skillName}/SKILL.md`;
            const adapter = this.plugin.app.vault.adapter;
            skillMd = (await adapter.exists(mdPath)) ? await adapter.read(mdPath) : null;
        } catch { skillMd = null; }
        const verdict = classifySkillScript({
            skillFolder: skillName,
            fileRelPath: `scripts/${scriptName}.js`,
            fileSource: source,
            skillMd,
            bundle: castGenerated<Record<string, Record<string, string>>>(BUNDLED_SKILLS),
        });
        if (verdict.kind === 'tampered') {
            callbacks.pushToolResult(this.formatError(new Error(
                `Refusing to run ${skillName}/scripts/${scriptName}.js: ${verdictReason(verdict)}. `
                + 'A skill the plugin ships runs only from the copy the plugin ships. '
                + 'To customise it, use write_skill, which turns the skill into a local copy first.',
            )));
            return;
        }

        // SBX-2 (defense-in-depth): reject obviously dangerous source patterns
        // before compiling/executing. The Chromium iframe sandbox is the real
        // boundary now; this is belt-and-suspenders and gives a clear error.
        const astCheck = AstValidator.validate(source);
        if (!astCheck.valid) {
            callbacks.pushToolResult(
                this.formatError(new Error(`Skill script rejected by validator: ${astCheck.errors.join('; ')}`)),
            );
            return;
        }

        // Compile via EsbuildWasm
        const esbuild = this.plugin.esbuildWasmManager;
        const sandbox = this.plugin.sandboxExecutor;
        if (!esbuild || !sandbox) {
            callbacks.pushToolResult(
                this.formatError(new Error('Sandbox executor or bundler unavailable in this build')),
            );
            return;
        }

        let compiled: string;
        // FEAT-29-06 Task B: cache lookup by skill+script+source-hash.
        // A second invocation with identical source skips the bundler.
        const cached = this.cache.get(skillName, scriptName, source);
        if (cached !== null) {
            compiled = cached;
        } else {
            try {
                // Use transform (no deps) for simple scripts. A future hint
                // could parse `// @deps: [...]` from the source header and
                // call build() instead. For now transform handles all current
                // scripts in production skills.
                compiled = await esbuild.transform(source);
            } catch (e) {
                callbacks.pushToolResult(
                    this.formatError(new Error(`Script bundler error: ${(e as Error).message ?? String(e)}`)),
                );
                return;
            }
            this.cache.set(skillName, scriptName, source, compiled);
        }

        // Execute in sandbox
        // FIX-44-04 / FIX-44-43: the task travels with the execution so
        // sandbox vault writes are checkpointed under exactly this task,
        // even when another task's script overlaps on the shared sandbox.
        // A skill script cannot find its own folder: the sandbox has no __dirname,
        // and the agent folder is a free-form user setting (settings.agentFolderPath),
        // so no script can derive or guess it. Without this, scripts hardcode
        // '.vault-operator/data/skills' and write into nothing the moment a user
        // renames their agent folder. The host already resolved the path above, so
        // it hands it over. Spread last: these keys are facts, not agent input.
        const skillDataRoot = skillsDir.replace(/(^|\/)skills$/, '$1skill-data');
        // FIX-24-03-10: the loop budget is a fact of the host, like the paths.
        // A script that plans work -- how many sources to visit, how many
        // articles to read -- can only match it to reality if it knows the
        // reality. Note the runtime nudges the agent to wrap up at 60% of this
        // number, so a script should plan against that fraction, not the whole.
        // This is the configured setting; a subtask may run on a shorter
        // budget of its own, which the tool cannot see from here.
        const maxIterations = this.plugin.settings?.advancedApi?.maxIterations ?? 25;
        const scriptArgs = {
            ...args,
            skills_root: skillsDir,
            skill_data_root: skillDataRoot,
            skill_name: skillName,
            max_iterations: maxIterations,
        };

        try {
            const result = await sandbox.execute(compiled, scriptArgs, {
                governanceTaskId: context.taskId,
                // FIX-24-08-04: abort the running script the moment Stop fires.
                abortSignal: context.abortSignal,
            });
            // FIX-24-03-08: kompakt, nicht pretty. Der Konsument ist das
            // Modell, und Einrueckung kostete 25 Prozent der Nahtstelle --
            // genug, um ein wachsendes Ergebnis ueber die Inline-Schwelle zu
            // heben und den Lauf in eine Re-Read-Kaskade zu schicken.
            callbacks.pushToolResult(this.formatSuccess(JSON.stringify(result)));
            callbacks.log(`Executed skill-script: ${skillName}/${scriptName}`);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            callbacks.pushToolResult(
                this.formatError(new Error(`Script execution error: ${msg}`)),
            );
        }
    }
}
