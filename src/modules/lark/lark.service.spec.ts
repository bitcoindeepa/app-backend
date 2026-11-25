import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { LarkService } from './lark.service';

const URL = 'https://open.larksuite.com/open-apis/bot/v2/hook/abc';

function setup(env: Record<string, string | undefined>) {
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  return new LarkService(config);
}

function mockFetch(status: number, body: unknown) {
  return jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

const data = {
  subject: 'Bitcoin Deepa member',
  fields: [
    { label: 'User ID', value: 'u1' },
    { label: 'Email', value: null },
  ],
  diditUrl: 'https://business.didit.me/console/o/a/kyc/verifications/s1',
};

describe('LarkService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('skips without a webhook URL', async () => {
    const fetch = jest.spyOn(global, 'fetch');
    await expect(setup({}).sendKycInReview(data)).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('posts the card, dropping empty fields, with the Didit button', async () => {
    const fetch = mockFetch(200, { code: 0 });
    await expect(
      setup({ LARK_KYC_WEBHOOK_URL: URL }).sendKycInReview(data),
    ).resolves.toBe(true);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(URL);
    const body = JSON.parse(init.body as string);
    expect(body.sign).toBeUndefined();
    expect(body.card.header.title.content).toBe(
      '🔍 KYC in review: Bitcoin Deepa member',
    );
    expect(body.card.elements[0].text.content).toBe('User ID: u1');
    expect(body.card.elements[1].actions[0].url).toBe(data.diditUrl);
  });

  it('leaves the button out without a Didit link', async () => {
    const fetch = mockFetch(200, { code: 0 });
    await setup({ LARK_KYC_WEBHOOK_URL: URL }).sendKycInReview({
      ...data,
      diditUrl: null,
    });
    const body = JSON.parse(
      (fetch.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.card.elements).toHaveLength(1);
  });

  it('signs with the secret the way Lark checks it', async () => {
    const fetch = mockFetch(200, { code: 0 });
    await setup({
      LARK_KYC_WEBHOOK_URL: URL,
      LARK_KYC_WEBHOOK_SECRET: 'shh',
    }).sendKycInReview(data);
    const body = JSON.parse(
      (fetch.mock.calls[0][1] as RequestInit).body as string,
    );
    const expected = createHmac('sha256', `${body.timestamp}\nshh`)
      .update('')
      .digest('base64');
    expect(body.sign).toBe(expected);
  });

  it('reports a refusal sent as HTTP 200 with a non-zero code', async () => {
    mockFetch(200, { code: 19021, msg: 'sign match fail' });
    await expect(
      setup({ LARK_KYC_WEBHOOK_URL: URL }).sendKycInReview(data),
    ).resolves.toBe(false);
  });

  it('never throws when Lark is unreachable', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNRESET'));
    await expect(
      setup({ LARK_KYC_WEBHOOK_URL: URL }).sendKycInReview(data),
    ).resolves.toBe(false);
  });
});
