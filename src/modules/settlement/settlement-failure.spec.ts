import { describeFailure, retryDelayMinutes } from './settlement-failure';

describe('settlement failures', () => {
  it('waits 2^n minutes, or 4^n after a passing refusal', () => {
    expect(retryDelayMinutes(null, 3)).toBe(8);
    expect(retryDelayMinutes('REJECTED', 3)).toBe(8);
    expect(retryDelayMinutes('APPROVAL_DELIVERY', 3)).toBe(64);
    expect(retryDelayMinutes('BUSY', 1)).toBe(4);
  });

  it('adds a hint to known failures and keeps unknown ones as they are', () => {
    expect(describeFailure('LOW_BALANCE')).toBe(
      'LOW_BALANCE (top up our sending wallet)',
    );
    expect(describeFailure('APPROVAL_DELIVERY')).toContain(
      "the bot couldn't DM the approval request",
    );
    expect(describeFailure('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});
