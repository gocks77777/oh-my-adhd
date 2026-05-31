// Shared utilities for oh-my-adhd hook scripts (session-recall.mjs, stop-hook.mjs)

/**
 * Sanitize user-supplied strings for safe inclusion in hook output.
 * - Strips control characters (preserves emoji, Korean, CJK)
 * - Removes shell-interpolation metacharacters (`, $, <, >)
 * - Redacts prompt-injection patterns in EN and KO
 */
export const sanitize = (s, max) => String(s ?? "")
  .replace(/[\x00-\x1F\x7F]/g, " ")
  .replace(/[`$<>]/g, "")
  .replace(/\b(ignore|disregard)\s+(all|previous|prior)\b/gi, "[redacted]")
  .replace(/(이전|앞의|위의|모든)\s*(지시|명령|규칙)\s*(무시|잊어|버려)/g, "[redacted]")
  .slice(0, max);
