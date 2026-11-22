import { isAmount, lkr, ROUND_DOWN, toMoney } from './money';

/**
 * First-timer reward: bonus sats worth FIRST_TIMER_REWARD_LKR, added to a
 * member's first successful payment and sent with its sats (same transfer,
 * same memo). Off when unset, empty or 0, so a deploy never starts paying
 * out by itself.
 *
 * Returns the reward as a 2-dp LKR decimal string, or null when off.
 */
export function firstTimerRewardLkr(): string | null {
  const raw = process.env.FIRST_TIMER_REWARD_LKR?.trim();
  if (!raw || !isAmount(raw)) return null;
  const amount = lkr(toMoney(raw), ROUND_DOWN);
  return amount.gt(0) ? amount.toFixed(2) : null;
}
