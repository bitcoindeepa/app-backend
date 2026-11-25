import type { TransferFailure } from '../bitcoindeepa/bitcoindeepa.service';

/** `transaction.settlement_failure`: a send's failure, or an approval the bot rejected */
export type SettlementFailure = TransferFailure | 'APPROVAL_REJECTED';

/**
 * The bot refused for a passing reason and nothing was sent: retried as is,
 * on a slower schedule (4^n minutes instead of 2^n), so the attempts last
 * hours instead of half an hour.
 */
export const RETRY_LATER_FAILURES: readonly SettlementFailure[] = [
  'APPROVAL_DELIVERY',
  'BUSY',
];

/**
 * Retrying can't help until someone changes something: retries stop at once
 * and the alert goes out on the first failure.
 */
export const NEEDS_HUMAN_FAILURES: readonly SettlementFailure[] = [
  'OVER_LIMIT',
  'NO_WALLET',
];

/** Minutes to wait after attempt `attempt` failed with `failure` */
export function retryDelayMinutes(
  failure: string | null | undefined,
  attempt: number,
): number {
  const base = RETRY_LATER_FAILURES.includes(failure as SettlementFailure)
    ? 4
    : 2;
  return Math.pow(base, attempt);
}

const FAILURE_HINTS: Record<SettlementFailure, string> = {
  LOW_BALANCE: 'top up our sending wallet',
  APPROVAL_DELIVERY:
    "the bot couldn't DM the approval request: check our sending wallet owner's chat with the bot",
  BUSY: 'the bot was still processing a send with this memo: check the bot history for it before resetting',
  OVER_LIMIT: "above the bot's per-transfer max for our sending wallet",
  NO_WALLET: "the bot doesn't know the recipient's (or our) wallet",
  REJECTED: 'the bot refused it: see the "Settlement of <id>" logs',
  AUTH: 'the bot rejected our signed request: key, wallet id, clock or IP',
  UNKNOWN:
    'no answer from the bot: check the bot history for the memo before resetting',
  APPROVAL_REJECTED: 'the approval was rejected or expired in the bot',
};

/** "OVER_LIMIT (above the bot's ...)" for alerts and the reminder */
export function describeFailure(failure: string): string {
  const hint = FAILURE_HINTS[failure as SettlementFailure];
  return hint ? `${failure} (${hint})` : failure;
}
