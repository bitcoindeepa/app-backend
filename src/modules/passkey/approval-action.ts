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

/** The action's key, or null when the fields it needs are missing */
export function approvalKey(
  kind: ApprovalKind,
  input: ApprovalInput,
): string | null {
  if (kind === 'p2p_send') {
    const to = part(input.to_telegram_id);
    const amount = part(input.amount);
    const key = part(input.idempotency_key);
    if (!/^\d+$/.test(to) || !/^\d+$/.test(amount) || !key) return null;
    // Numbers are compared as integers ("0100" and 100 are the same send)
    return `p2p_send:${BigInt(to)}:${BigInt(amount)}:${key}`;
  }
  const order = part(input.order_id).toLowerCase();
  return order ? `sell_pay:${order}` : null;
}

/** Header the app sends the approval in: base64url(JSON of the WebAuthn response) */
export const APPROVAL_HEADER = 'x-passkey-assertion';
