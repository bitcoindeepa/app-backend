/**
 * What a passkey approval approves. The key is stored with the challenge
 * when the app asks for one (POST /passkey/approve/options) and rebuilt from
 * the real request by PasskeyApprovalGuard, so an approval for one send
 * (recipient, amount, idempotency key) or one sale can't be used for another.
 */
export type ApprovalKind = 'p2p_send' | 'sell_pay';

export interface ApprovalInput {
  to_telegram_id?: unknown;
  amount?: unknown;
  idempotency_key?: unknown;
  order_id?: unknown;
}

const part = (value: unknown): string =>
  typeof value === 'number' || typeof value === 'string'
    ? String(value).trim()
    : '';

/**
 * A positive whole number as P2pSendDto sees it: it converts with Number()
 * (@Type(() => Number), then @IsInt @Min(1)), so "1e3", "1000.0" and 1000
 * are the same send here too. Null for anything it would refuse.
 */
const whole = (value: unknown): number | null => {
  if (!['number', 'string', 'boolean'].includes(typeof value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
};

/** The action's key, or null when the fields it needs are missing */
export function approvalKey(
  kind: ApprovalKind,
  input: ApprovalInput,
): string | null {
  if (kind === 'p2p_send') {
    const to = whole(input.to_telegram_id);
    const amount = whole(input.amount);
    const key = part(input.idempotency_key);
    if (to === null || amount === null || !key) return null;
    return `p2p_send:${to}:${amount}:${key}`;
  }
  const order = part(input.order_id).toLowerCase();
  return order ? `sell_pay:${order}` : null;
}

/** Header the app sends the approval in: base64url(JSON of the WebAuthn response) */
export const APPROVAL_HEADER = 'x-passkey-assertion';
