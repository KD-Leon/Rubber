/**
 * FEAT-44-02b: pure mapping from the batch gate's outcome to the Pipeline's
 * ApprovalResult.
 *
 * The batch gate (EditReviewModal with readonlyContent) answers with
 * per-entry decisions. What the Pipeline needs is a single ApprovalResult:
 * rejected when the user gave no consent at all (discarded, dismissed, or
 * skipped everything), approved with an `approvedPaths` subset when some
 * entries were skipped, and approved WITHOUT the subset when the whole
 * planned scope was kept -- absence means "full scope", which keeps the
 * common case allocation-free and lets the tool skip subset filtering.
 *
 * finalContent is never forwarded: the batch gate offers no editing surface,
 * and the Pipeline drops stray finalContent from batch approvals anyway
 * (a single-file write would silently replace the rest of the batch).
 */

import type { ApprovalResult } from '../../core/tool-execution/ToolExecutionPipeline';
import type { EditReviewResult } from './EditReviewModal';

export function decideBatchApproval(result: EditReviewResult): ApprovalResult {
    if (!result.decisions) {
        return { decision: 'rejected', reason: 'Rejected by user in the batch review.' };
    }
    const approved = result.decisions.filter((d) => !d.skipped).map((d) => d.path);
    if (approved.length === 0) {
        return { decision: 'rejected', reason: 'All files were skipped in the batch review.' };
    }
    const base: ApprovalResult = {
        decision: 'approved',
        rememberForRun: result.rememberForRun === true,
        rememberForSession: result.rememberForSession === true,
    };
    if (approved.length < result.decisions.length) {
        base.approvedPaths = approved;
    }
    return base;
}
