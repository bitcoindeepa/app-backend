/**
 * A session's own page in the Didit console:
 * <console>/<organization>/<application>/kyc/verifications/<session_id>.
 *
 * The organization and application come from `DIDIT_CONSOLE_PATH`, whatever
 * console page it points at (e.g. https://business.didit.me/console/<org>/<app>/users).
 * Null when the path is unset or is not a console URL.
 */
export function diditSessionConsoleUrl(
  consolePath: string | undefined,
  sessionId: string | undefined,
): string | null {
  if (!sessionId) return null;
  const application = /^https?:\/\/[^/]+\/console\/[^/?#]+\/[^/?#]+/.exec(
    consolePath || '',
  );
  if (!application) return null;
  return `${application[0]}/kyc/verifications/${encodeURIComponent(sessionId)}`;
}
