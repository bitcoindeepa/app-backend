import { diditSessionConsoleUrl } from './console-url.util';

describe('diditSessionConsoleUrl', () => {
  it("links the session from any page of the application's console", () => {
    expect(
      diditSessionConsoleUrl(
        'https://business.didit.me/console/org1/app1/users?vendor_data=x',
        's 1',
      ),
    ).toBe(
      'https://business.didit.me/console/org1/app1/kyc/verifications/s%201',
    );
  });

  it('is null without a console path, a console URL or a session', () => {
    expect(diditSessionConsoleUrl(undefined, 's1')).toBeNull();
    expect(diditSessionConsoleUrl('https://didit.me/pricing', 's1')).toBeNull();
    expect(
      diditSessionConsoleUrl(
        'https://business.didit.me/console/o/a',
        undefined,
      ),
    ).toBeNull();
  });
});
