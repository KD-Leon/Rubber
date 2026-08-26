/**
 * Lightweight text parser for Obsidian `.base` YAML files.
 *
 * Extracted from QueryBaseTool so the view-boundary logic can be unit
 * tested without booting the Obsidian runtime.
 *
 * AUDIT-038 ISSUE-006 fix: the previous in-class implementation had a
 * tautological guard (`line !== lines[i]`) and only recognised
 * `- type: table` as a view header. With multiple views in one file
 * filters from the next view could bleed into the requested one, and
 * any non-table view (cards, list, ...) silently broke the boundary
 * altogether. The new parser uses a single view-header pattern that
 * matches every `- type:` line and resets `inTargetView` on each.
 *
 * Not a full YAML parser by design (the original commit took the same
 * shortcut for the MVP), but the boundary is now driven by the actual
 * structural marker instead of a no-op string compare.
 */

const VIEW_HEADER_RE = /^\s*-\s*type:\s*/;

/**
 * Returns the list of filter conditions (strings as written in the
 * YAML) declared inside the requested view. An empty `viewName` means
 * "first view encountered", matching the existing behaviour.
 */
export function extractFilters(yaml: string, viewName: string): string[] {
    const lines = yaml.split('\n');
    let inTargetView = false;
    let inFilters = false;
    const filters: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (VIEW_HEADER_RE.test(line)) {
            const nameLine = lines[i + 1]?.trim() ?? '';
            const name = nameLine.startsWith('name:')
                ? nameLine.replace('name:', '').trim()
                : '';
            inTargetView = !viewName || name === viewName;
            inFilters = false;
            continue;
        }
        if (!inTargetView) continue;
        if (line.trim() === 'filters:' || line.trim() === 'and:') {
            inFilters = true;
            continue;
        }
        if (inFilters) {
            const m = line.match(/^\s+- (.+)$/);
            if (m) {
                filters.push(m[1].replace(/^'|'$/g, '').trim());
            } else if (line.match(/^\s{4}[a-z]/) && !line.includes('- ')) {
                inFilters = false;
            }
        }
    }
    return filters;
}

/**
 * Returns the list of fields in the `order:` block of the requested
 * view (same view-name semantics as extractFilters).
 */
export function extractOrder(yaml: string, viewName: string): string[] {
    const lines = yaml.split('\n');
    let inTargetView = false;
    let inOrder = false;
    const order: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (VIEW_HEADER_RE.test(line)) {
            const nameLine = lines[i + 1]?.trim() ?? '';
            const name = nameLine.startsWith('name:')
                ? nameLine.replace('name:', '').trim()
                : '';
            inTargetView = !viewName || name === viewName;
            inOrder = false;
            continue;
        }
        if (!inTargetView) continue;
        if (line.trim() === 'order:') {
            inOrder = true;
            continue;
        }
        if (inOrder) {
            const m = line.match(/^\s+- (.+)$/);
            if (m) {
                order.push(m[1].trim());
            } else {
                inOrder = false;
            }
        }
    }
    return order;
}
