/**
 * FIX-54-11: pure helpers for mapping provider errors to friendly titles.
 *
 * Extracted from AgentSidebarView.getErrorTitle so the classification is
 * unit-testable (the view class cannot be instantiated under vitest).
 */

const PERMISSIONS_RE = /insufficient permissions?|missing scopes?|does not have access to (?:the )?model/i;

/**
 * A 401/403 whose body is a scope or model-access rejection, not a bad key.
 * OpenAI project keys with model restrictions answer exactly
 * "You have insufficient permissions for this operation." while the key
 * itself is perfectly valid; titling that "Invalid API key" sends the user
 * to the wrong fix. Without a structured status the wording alone decides,
 * because the phrase does not occur in other provider error bodies.
 */
export function isInsufficientPermissionsAuthError(message: string, status?: number): boolean {
    if (!PERMISSIONS_RE.test(message)) return false;
    return status === undefined || status === 401 || status === 403;
}
