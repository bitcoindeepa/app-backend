import { firstTimerRewardLkr } from './first-timer-reward';

describe('firstTimerRewardLkr', () => {
  const original = process.env.FIRST_TIMER_REWARD_LKR;
  afterEach(() => {
    if (original === undefined) delete process.env.FIRST_TIMER_REWARD_LKR;
    else process.env.FIRST_TIMER_REWARD_LKR = original;
  });

  it.each([undefined, '', '  ', '0', '0.00', 'abc', '-5'])(
    'is off for %p',
    (value) => {
      if (value === undefined) delete process.env.FIRST_TIMER_REWARD_LKR;
      else process.env.FIRST_TIMER_REWARD_LKR = value;
      expect(firstTimerRewardLkr()).toBeNull();
    },
  );

  it.each([
    ['500', '500.00'],
    ['250.5', '250.50'],
    ['99.999', '99.99'], // rounded down to cents
  ])('%p → %p LKR', (value, expected) => {
    process.env.FIRST_TIMER_REWARD_LKR = value;
    expect(firstTimerRewardLkr()).toBe(expected);
  });
});
