import { approvalClaimSeconds } from './bank-account.service';

describe('approvalClaimSeconds', () => {
  const original = process.env.CEYPAY_TIMEOUT;
  afterEach(() => {
    if (original === undefined) delete process.env.CEYPAY_TIMEOUT;
    else process.env.CEYPAY_TIMEOUT = original;
  });

  it('is 120s at the default 10s CeyPay timeout', () => {
    delete process.env.CEYPAY_TIMEOUT;
    expect(approvalClaimSeconds()).toBe(120);
  });

  // 3 calls × 40s = 120s: a fixed 120s claim could be taken over mid-call
  it('outlasts 3 CeyPay calls plus a margin when the timeout is raised', () => {
    process.env.CEYPAY_TIMEOUT = '40000';
    expect(approvalClaimSeconds()).toBe(150);
    process.env.CEYPAY_TIMEOUT = '60000';
    expect(approvalClaimSeconds()).toBe(210);
  });

  it('falls back to the default for an unusable value', () => {
    process.env.CEYPAY_TIMEOUT = 'soon';
    expect(approvalClaimSeconds()).toBe(120);
  });
});
