import { cleanTgUsername } from './user.service';

describe('cleanTgUsername', () => {
  it.each([
    ['dinesh2k21', 'dinesh2k21'],
    ['@Nimal_TG', 'Nimal_TG'],
    ['  spaced  ', 'spaced'],
    [undefined, null],
    ['', null],
    ['abc', null], // too short
    ['has space', null],
    ['<b>x</b>', null],
    ['a'.repeat(33), null],
  ])('%p -> %p', (input, expected) => {
    expect(cleanTgUsername(input)).toBe(expected);
  });
});
