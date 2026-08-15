/**
 * The largest file Aura will write over, remove, or replace with a link.
 *
 * A mutation is only reversible if its previous contents were captured, so this doubles as the
 * ceiling on what one operation retains in memory. Agent configuration is measured in kilobytes;
 * anything approaching this size is not something a fix should be rewriting unattended.
 */
export const MAX_MUTABLE_FILE_BYTES = 4 * 1024 * 1024;

/**
 * The most file content Aura retains across a whole plan.
 *
 * {@link MAX_MUTABLE_FILE_BYTES} bounds one operation; without a plan-wide budget a long plan still
 * multiplies it by the operation count.
 */
export const MAX_RETAINED_PLAN_BYTES = 64 * 1024 * 1024;

/**
 * The combined before/after size above which a preview summarizes instead of rendering a patch.
 *
 * A unified diff is larger than the inputs that produced it, and a preview no human can read is not
 * worth the memory it costs.
 */
export const MAX_DIFF_BYTES = 256 * 1024;

/** The mode a {@link WriteFileOperation} gets when it does not ask for one. */
export const DEFAULT_FILE_MODE = 0o644;
