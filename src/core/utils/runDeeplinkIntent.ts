/**
 * runDeeplinkIntent -- what a link-triggered skill run may say about itself
 * (IMP-43-01-01).
 *
 * FEAT-43-01 allows obsidian://vault-operator-run to carry ONLY a validated
 * slug, and gates every start behind a confirmation, because any web page can
 * fire these URLs. Both rules stay. The one generic modal text broke the
 * dashboard's verdict hand-over, though: "edit with agent" produced "Start
 * skill run?", which reads as a fresh paid research run instead of the cheap
 * takeover it orders. The link may now name an intent -- from this HARD
 * whitelist, never free text -- and the modal speaks accordingly. An unknown
 * or missing intent is the generic run, so a forged value degrades to the
 * most cautious wording instead of a friendlier one it did not earn.
 */

export const RUN_INTENTS = ['run', 'revise', 'takeover'] as const;
export type RunIntent = (typeof RUN_INTENTS)[number];

const KEYS: Record<RunIntent, { title: string; message: string; button: string }> = {
    run: {
        title: 'protocol.runSkillConfirmTitle',
        message: 'protocol.runSkillConfirmMessage',
        button: 'protocol.runSkillConfirmButton',
    },
    revise: {
        title: 'protocol.runSkillConfirmTitleRevise',
        message: 'protocol.runSkillConfirmMessageRevise',
        button: 'protocol.runSkillConfirmButtonRevise',
    },
    takeover: {
        title: 'protocol.runSkillConfirmTitleTakeover',
        message: 'protocol.runSkillConfirmMessageTakeover',
        button: 'protocol.runSkillConfirmButtonTakeover',
    },
};

export function resolveRunIntent(params: Record<string, string>): RunIntent {
    const raw = params?.intent;
    return (RUN_INTENTS as readonly string[]).includes(raw) && raw !== 'run'
        ? (raw as RunIntent)
        : 'run';
}

resolveRunIntent.keysFor = (intent: RunIntent) => KEYS[intent];

/**
 * The line that travels into the chat behind the slash command, so the run
 * says what it is. A bare "/daily-briefing" is indistinguishable from a full
 * research run: on 2026-08-22 the user cancelled exactly there, and the
 * queued note edit sat untouched. The text lives HERE, in the plugin, chosen
 * by a whitelisted intent -- never carried by the link, so FEAT-43-01's
 * no-free-prompt rule holds. The generic run adds nothing, because a plain
 * start needs no explanation.
 */
resolveRunIntent.hintKeyFor = (intent: RunIntent): string | null =>
    (intent === 'run' ? null : `protocol.runSkillIntentHint${intent[0].toUpperCase()}${intent.slice(1)}`);
