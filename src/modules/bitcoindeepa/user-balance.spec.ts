import { potSats, spendableSats } from './bitcoindeepa.service';

describe('spendableSats', () => {
  it('uses the bot’s available_balance (pots excluded)', () => {
    expect(
      spendableSats({
        success: true,
        balance: 10_000,
        available_balance: 5_500,
        pot_balance: 4_500,
      }),
    ).toBe(5_500);
  });

  it('keeps a 0 available_balance (everything in pots)', () => {
    expect(
      spendableSats({ success: true, balance: 4_000, available_balance: 0 }),
    ).toBe(0);
  });

  it('falls back to the whole balance for a bot without pot fields', () => {
    expect(spendableSats({ success: true, balance: 7_000 })).toBe(7_000);
  });

  it('is undefined without any balance', () => {
    expect(spendableSats({ success: false, message: 'x' })).toBeUndefined();
  });
});

describe('potSats', () => {
  it('reads pot_balance, 0 when missing', () => {
    expect(potSats({ success: true, balance: 1, pot_balance: 300 })).toBe(300);
    expect(potSats({ success: true, balance: 1 })).toBe(0);
  });
});
