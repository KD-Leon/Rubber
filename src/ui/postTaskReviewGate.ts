/**
 * FIX-44-44 (review follow-up): pure decision logic for the two post-task
 * surfaces in AgentSidebarView's onComplete handler. Extracted so the gate is
 * unit-testable (the view class itself is not vitest-able).
 *
 * - Undo bar: legacy surface, counts only the six classic CUD tools
 *   (write_file/edit_file/append_to_file/create_folder/delete_file/move_file)
 *   and stays hidden once inline checkpoint markers rendered.
 * - Post-task review: opens when at least one write landed WITHOUT an
 *   individual diff approval (pipeline signal onUnreviewedWrite). This must
 *   NOT be additionally gated on the legacy write count: the very tools that
 *   motivated FIX-44-44 (update_frontmatter, set_block_anchors,
 *   generate_canvas, create_base, ingest_*, Office creators, ...) are not in
 *   that six-tool list, so the count stays 0 while unreviewed writes exist.
 */

export interface PostTaskSurfaceState {
    /** Writes counted via the legacy six-tool name list (undo bar only). */
    taskWriteCount: number;
    /** Pipeline reported >= 1 successful write without an individual diff approval. */
    taskHadUnreviewedWrites: boolean;
    /** settings.enableCheckpoints (default true). */
    enableCheckpoints: boolean;
    /** Inline checkpoint markers already rendered during the run. */
    hasRenderedCheckpoints: boolean;
}

export interface PostTaskSurfaces {
    showUndoBar: boolean;
    showPostTaskReview: boolean;
}

export function decidePostTaskSurfaces(s: PostTaskSurfaceState): PostTaskSurfaces {
    return {
        showUndoBar: s.taskWriteCount > 0 && s.enableCheckpoints && !s.hasRenderedCheckpoints,
        // No taskWriteCount conjunct here: taskHadUnreviewedWrites already
        // implies at least one successful write, and the count only covers
        // the six classic tools. showPostTaskReview itself no-ops when the
        // task has no checkpoints.
        showPostTaskReview: s.taskHadUnreviewedWrites && s.enableCheckpoints,
    };
}
