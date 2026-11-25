import { relyingParty } from './passkey-config';
import { approvalKey } from './approval-action';
import { isSessionLocked, UNLOCK_TTL_MS } from '../auth/session.service';

describe('relyingParty', () => {
  afterEach(() => {
    delete process.env.APP_URL;
    delete process.env.WEBAUTHN_RP_ID;
  });

  it("defaults the RP ID to APP_URL's host and accepts every APP_URL origin", () => {
    process.env.APP_URL =
      'https://app.bitcoindeepa.com/, https://beta.bitcoindeepa.com';
    expect(relyingParty()).toEqual({
      id: 'app.bitcoindeepa.com',
      name: 'Bitcoin Deepa',
      origins: [
        'https://app.bitcoindeepa.com',
        'https://beta.bitcoindeepa.com',
      ],
    });
  });

  it('uses WEBAUTHN_RP_ID when set', () => {
    process.env.APP_URL = 'https://app.bitcoindeepa.com';
    process.env.WEBAUTHN_RP_ID = 'bitcoindeepa.com';
    expect(relyingParty()?.id).toBe('bitcoindeepa.com');
  });

  it('is null without APP_URL', () => {
    expect(relyingParty()).toBeNull();
  });
});

describe('isSessionLocked', () => {
  const now = Date.parse('2026-11-25T12:00:00Z');

  it('never locks without a passkey, nor the Mini App', () => {
    expect(isSessionLocked('web', false, null, now)).toBe(false);
    expect(isSessionLocked('miniapp', true, null, now)).toBe(false);
  });

  it('locks a web session until it unlocks, and again once that is too old', () => {
    expect(isSessionLocked('web', true, null, now)).toBe(true);
    expect(isSessionLocked('web', true, new Date(now - 60_000), now)).toBe(
      false,
    );
    expect(
      isSessionLocked('web', true, new Date(now - UNLOCK_TTL_MS - 1), now),
    ).toBe(true);
  });
});

describe('approvalKey', () => {
  it('binds a send to its recipient, amount and payment key', () => {
    const body = {
      to_telegram_id: 100000002,
      amount: 1000,
      idempotency_key: 'k1',
    };
    expect(approvalKey('p2p_send', body)).toBe('p2p_send:100000002:1000:k1');
    // Same send however the numbers are written
    expect(
      approvalKey('p2p_send', {
        ...body,
        to_telegram_id: '100000002',
        amount: '01000',
      }),
    ).toBe('p2p_send:100000002:1000:k1');
    // Every form P2pSendDto's Number() conversion accepts maps to the same key
    for (const amount of ['1e3', '1000.0', '+1000', ' 1000 ', '0x3e8']) {
      expect(approvalKey('p2p_send', { ...body, amount })).toBe(
        'p2p_send:100000002:1000:k1',
      );
    }
    expect(approvalKey('p2p_send', { ...body, amount: 1001 })).not.toBe(
      approvalKey('p2p_send', body),
    );
  });

  it('is null when a field is missing or malformed', () => {
    expect(
      approvalKey('p2p_send', { amount: 1000, idempotency_key: 'k' }),
    ).toBeNull();
    expect(
      approvalKey('p2p_send', {
        to_telegram_id: 1,
        amount: -5,
        idempotency_key: 'k',
      }),
    ).toBeNull();
    expect(
      approvalKey('p2p_send', {
        to_telegram_id: 1,
        amount: 1.5,
        idempotency_key: 'k',
      }),
    ).toBeNull();
    expect(approvalKey('sell_pay', {})).toBeNull();
  });

  it('binds a sale payment to its order', () => {
    expect(approvalKey('sell_pay', { order_id: 'ABC-1' })).toBe(
      'sell_pay:abc-1',
    );
  });
});
