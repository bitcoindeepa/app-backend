import { Logger } from '@nestjs/common';
import { TelegramLoggerService } from './telegram-logger.service';

describe('TelegramLoggerService.logAlert', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = '123:abc';
    process.env.LOG_GROUP_ID = '-100';
    fetchMock.mockReset().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: { message_id: 1 } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const call = (i: number) => {
    const [url, init] = fetchMock.mock.calls[i] as [string, { body: string }];
    return {
      method: url.split('/').pop(),
      body: JSON.parse(init.body) as {
        text?: string;
        parse_mode?: string;
        rich_message?: { html: string };
      },
    };
  };
  /** What Telegram counts against its limit: the text after it parses the HTML */
  const parsedLength = (html: string) =>
    html.replace(/<[^>]+>/g, '').replace(/&(?:lt|gt|amp|quot);/g, '_').length;
  const refused = (status: number) =>
    Promise.resolve({
      ok: false,
      status,
      json: () => Promise.resolve({ ok: false, description: 'Bad Request' }),
    });

  it('sends a rich message: escaped heading, the text as paragraphs', async () => {
    await new TelegramLoggerService().logAlert(
      'PayHere <api>',
      'Error: <html>Bad Gateway</html> & retry\n\nsecond line',
    );
    expect(call(0).method).toBe('sendRichMessage');
    expect(call(0).body.rich_message?.html).toBe(
      '<h3>⚠️ PayHere &lt;api&gt;</h3><p>Error: &lt;html&gt;Bad Gateway&lt;/html&gt; &amp; retry</p><p>second line</p>',
    );
  });

  it('uses the caller rich HTML when given', async () => {
    await new TelegramLoggerService().logAlert('Waiting for review', 'plain', {
      richHtml: '<table><tr><td>x</td></tr></table>',
    });
    expect(call(0).body.rich_message?.html).toBe(
      '<h3>⚠️ Waiting for review</h3><table><tr><td>x</td></tr></table>',
    );
  });

  it('shows the level icon and title in the heading, and the fields as a table (rich) or lines (plain)', async () => {
    fetchMock.mockImplementationOnce(() => refused(400));
    await new TelegramLoggerService().logAlert(
      'Settlement',
      'Approve it in the bot chat.',
      {
        level: 'waiting',
        title: 'waiting for approval',
        fields: [
          ['Payment', 'P<1>', 'code'],
          ['User', '#UID42'],
        ],
      },
    );
    expect(call(0).body.rich_message?.html).toBe(
      '<h3>⏳ Settlement: waiting for approval</h3><p>Approve it in the bot chat.</p>' +
        '<table compact><tr><td><b>Payment</b></td><td><code>P&lt;1&gt;</code></td></tr>' +
        '<tr><td><b>User</b></td><td>#UID42</td></tr></table>',
    );
    expect(call(1).body.text).toBe(
      '⏳ <b>Settlement: waiting for approval</b>\nApprove it in the bot chat.\n' +
        'Payment: <code>P&lt;1&gt;</code>\nUser: #UID42',
    );
  });

  it('falls back to the escaped plain HTML message when the rich one is refused', async () => {
    fetchMock.mockImplementationOnce(() => refused(400));
    await new TelegramLoggerService().logAlert(
      'PayHere <api>',
      'Error: <html>Bad Gateway</html> & retry',
    );
    expect(call(1).method).toBe('sendMessage');
    expect(call(1).body.parse_mode).toBe('HTML');
    expect(call(1).body.text).toBe(
      '⚠️ <b>PayHere &lt;api&gt;</b>\nError: &lt;html&gt;Bad Gateway&lt;/html&gt; &amp; retry',
    );
  });

  it('cuts the plain fallback to Telegram 4096 characters, keeping the heading and fields', async () => {
    fetchMock.mockImplementationOnce(() => refused(400));
    await new TelegramLoggerService().logAlert(
      'Waiting for review',
      `reason: ${'<&>'.repeat(3000)}`,
      { fields: [['User', '#UID42']] },
    );
    const text = call(1).body.text ?? '';
    expect(parsedLength(text)).toBeLessThanOrEqual(4096);
    // and the cut uses the room: not cut early by the escaped length
    expect(parsedLength(text)).toBeGreaterThan(4000);
    expect(text.startsWith('⚠️ <b>Waiting for review</b>\nreason: ')).toBe(
      true,
    );
    expect(text.endsWith('…\nUser: #UID42')).toBe(true);
    // never cut inside an entity
    expect(text).not.toMatch(/&(?!amp;|lt;|gt;)/);
  });

  it('budgets the plain fallback by the characters Telegram counts, not the escaped length', async () => {
    fetchMock.mockImplementationOnce(() => refused(400));
    // 1,000 "&" = 5,000 escaped characters but only 1,000 for Telegram: fits
    const text = '&'.repeat(1000);
    await new TelegramLoggerService().logAlert('S', text);
    expect(call(1).body.text).toBe(`⚠️ <b>S</b>\n${'&amp;'.repeat(1000)}`);
  });

  it('caps each field value, so long fields still leave a plain fallback Telegram accepts', async () => {
    fetchMock.mockImplementationOnce(() => refused(400));
    await new TelegramLoggerService().logAlert('Settlement', 'refused', {
      fields: [
        ['Bot said', `${'<x>'.repeat(2000)}`],
        ['Payment', 'P1', 'code'],
      ],
    });
    const rich = call(0).body.rich_message?.html ?? '';
    const plain = call(1).body.text ?? '';
    expect(parsedLength(plain)).toBeLessThanOrEqual(4096);
    expect(plain).toContain('refused');
    expect(plain.endsWith('…\nPayment: <code>P1</code>')).toBe(true);
    // 499 characters kept + the ellipsis, cut before escaping
    expect(plain).toContain(`Bot said: ${'&lt;x&gt;'.repeat(166)}&lt;…`);
    expect(rich).toContain(`${'&lt;x&gt;'.repeat(166)}&lt;…</td>`);
  });

  it('stops trying rich messages once the Bot API says it has no such method', async () => {
    const service = new TelegramLoggerService();
    fetchMock.mockImplementationOnce(() => refused(404));
    await service.logAlert('S', 'one');
    await service.logAlert('S', 'two');
    expect([0, 1, 2].map((i) => call(i).method)).toEqual([
      'sendRichMessage',
      'sendMessage',
      'sendMessage',
    ]);
  });

  describe('topic', () => {
    const sentTopics = () =>
      fetchMock.mock.calls.map(
        (call) =>
          (
            JSON.parse((call as [string, { body: string }])[1].body) as {
              message_thread_id?: string;
            }
          ).message_thread_id,
      );
    afterEach(() => {
      delete process.env.LOG_TOPIC_ID;
      delete process.env.ALERT_TOPIC_ID;
    });

    it('sends alerts to ALERT_TOPIC_ID and routine logs to LOG_TOPIC_ID', async () => {
      process.env.LOG_TOPIC_ID = '7';
      process.env.ALERT_TOPIC_ID = '9';
      const service = new TelegramLoggerService();
      await service.logAlert('Settlement', 'needs a human');
      await service.logGenericAction('routine', { id: '42' });
      expect(sentTopics()).toEqual(['9', '7']);
    });

    it('falls back to LOG_TOPIC_ID when ALERT_TOPIC_ID is unset', async () => {
      process.env.LOG_TOPIC_ID = '7';
      await new TelegramLoggerService().logAlert('Settlement', 'x');
      expect(sentTopics()).toEqual(['7']);
    });
  });
});

describe('TelegramLoggerService routine logs', () => {
  const fetchMock = jest.fn();
  const sent = () =>
    JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { text: string; link_preview_options?: { is_disabled: boolean } };

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = '123:abc';
    process.env.LOG_GROUP_ID = '-100';
    fetchMock.mockReset().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: { message_id: 1 } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('links the Telegram username and shows the app one as code, never as a mention', async () => {
    await new TelegramLoggerService().logGenericAction('Buy', {
      id: '42',
      username: 'asa332',
      tgUsername: 'dinesh2k21',
    });
    expect(sent().text).toBe(
      '<b>Buy</b>\n' +
        'Telegram: <a href="https://t.me/dinesh2k21">dinesh2k21</a>\n' +
        'App user: <code>asa332</code>\n' +
        'User ID: <b>#UID42</b>',
    );
    expect(sent().text).not.toContain('@');
    expect(sent().link_preview_options).toEqual({ is_disabled: true });
  });

  it('keeps payment logs to an icon line, the details and the user last', async () => {
    const service = new TelegramLoggerService();
    await service.logNewTransaction(
      '320049',
      '25000.00',
      '42',
      'SUCCESS',
      true,
    );
    expect(sent().text).toBe(
      '💳 <b>New one-time buy</b> #BUY\n' +
        'Payment: #TRX320049\n' +
        'Amount: Rs. 25,000 · SUCCESS\n' +
        'User ID: <b>#UID42</b>',
    );
  });

  it('says so when either name is missing', async () => {
    await new TelegramLoggerService().logGenericAction('Buy', { id: '42' });
    expect(sent().text).toContain('Telegram: unknown\nApp user: not set');
  });
});

describe('TelegramLoggerService log group limits', () => {
  const fetchMock = jest.fn();
  const ok = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, result: { message_id: 1 } }),
    });
  const tooMany = (retryAfter: number) =>
    Promise.resolve({
      ok: false,
      status: 429,
      json: () =>
        Promise.resolve({
          ok: false,
          error_code: 429,
          description: `Too Many Requests: retry after ${retryAfter}`,
          parameters: { retry_after: retryAfter },
        }),
    });
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  const user = { id: '42', username: 'u' };

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = '123:abc';
    process.env.LOG_GROUP_ID = '-100';
    fetchMock.mockReset().mockImplementation(ok);
    global.fetch = fetchMock as unknown as typeof fetch;
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    warn.mockRestore();
    error.mockRestore();
  });

  it("pauses the group for Telegram's retry_after, then resumes and reports what was skipped", async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const service = new TelegramLoggerService();
    fetchMock.mockImplementationOnce(() => tooMany(34));
    await service.logGenericAction('first', user);
    expect(warn).toHaveBeenCalledWith(
      'Telegram rate limited the log group: pausing Telegram logs for 34s',
    );

    await service.logGenericAction('during the pause', user);
    await service.setMessageReaction({ id: 5, text: 'x' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // nothing sent while paused

    jest.setSystemTime(1_000_000 + 35_000);
    await service.logGenericAction('after', user);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      'Telegram log group: 1 message(s) skipped while rate limited', // the reaction isn't a message
    );
  });

  it('keeps routine logs under the per-minute limit, leaving room for alerts', async () => {
    const service = new TelegramLoggerService();
    for (let i = 0; i < 20; i++)
      await service.logGenericAction(`log ${i}`, user);
    expect(fetchMock).toHaveBeenCalledTimes(15);

    await service.logAlert('Settlement', 'needs a human');
    expect(fetchMock).toHaveBeenCalledTimes(16);
  });

  it('queues an alert stopped by a rate limit and sends it when the pause ends', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const service = new TelegramLoggerService();
    fetchMock.mockImplementationOnce(() => tooMany(10));
    await service.logAlert('Settlement', 'payout stuck');
    expect(error).toHaveBeenCalledWith(
      'ALERT (Settlement) delayed by Telegram rate limits, queued: payout stuck',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(11_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      (fetchMock.mock.calls[1] as [string, { body: string }])[1].body,
    ).toContain('payout stuck');
  });

  it("logs an alert Telegram refused for another reason (it's not retried)", async () => {
    const service = new TelegramLoggerService();
    const badRequest = () =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ ok: false, description: 'Bad Request' }),
      });
    // the rich message, then the plain fallback
    fetchMock
      .mockImplementationOnce(badRequest)
      .mockImplementationOnce(badRequest);
    await service.logAlert('Settlement', 'payout stuck');
    expect(error).toHaveBeenCalledWith(
      'ALERT (Settlement) not sent to Telegram: payout stuck',
    );
  });

  it('a queued alert whose rich form was refused is retried as plain text only', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const service = new TelegramLoggerService();
    fetchMock
      .mockImplementationOnce(() =>
        Promise.resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({ ok: false, description: 'Bad HTML' }),
        }),
      ) // the rich form is refused
      .mockImplementationOnce(() => tooMany(10)); // the plain fallback is limited
    await service.logAlert('Settlement', 'payout stuck');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(11_000);
    const methods = fetchMock.mock.calls.map(([url]) =>
      String(url).split('/').pop(),
    );
    expect(methods).toEqual(['sendRichMessage', 'sendMessage', 'sendMessage']);
  });

  it('sends plain alerts for an hour after 3 rich refusals in a row', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const service = new TelegramLoggerService();
    const badHtml = () =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ ok: false, description: 'Bad HTML' }),
      });
    // rich refused, plain sent - three times
    for (let i = 0; i < 3; i++) {
      fetchMock.mockImplementationOnce(badHtml).mockImplementationOnce(ok);
      await service.logAlert('S', `alert ${i}`);
    }
    const method = (i: number) =>
      String((fetchMock.mock.calls[i] as [string])[0])
        .split('/')
        .pop();
    await service.logAlert('S', 'during the pause');
    expect(method(6)).toBe('sendMessage'); // no rich try

    jest.setSystemTime(1_000_000 + 61 * 60_000);
    await service.logAlert('S', 'after the pause');
    expect(method(7)).toBe('sendRichMessage');
  });

  it('a 429 on a reaction delays a later alert instead of losing it', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const service = new TelegramLoggerService();
    fetchMock.mockImplementationOnce(() => tooMany(20));
    await service.setMessageReaction({ id: 7, text: 'x' });
    await service.logAlert('Sell', 'needs review');
    expect(fetchMock).toHaveBeenCalledTimes(1); // paused: the alert is queued
    await jest.advanceTimersByTimeAsync(21_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reactions count against the routine cap, so alerts keep their headroom', async () => {
    const service = new TelegramLoggerService();
    // each trackAction is a message + a reaction
    for (let i = 0; i < 10; i++) {
      await service.trackAction(`a${i}`, user, () => Promise.resolve());
    }
    expect(fetchMock).toHaveBeenCalledTimes(15);
    await service.logAlert('Settlement', 'needs a human');
    expect(fetchMock).toHaveBeenCalledTimes(16);
  });

  it('keeps at most 20 queued alerts; the rest are only logged', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const service = new TelegramLoggerService();
    fetchMock.mockImplementationOnce(() => tooMany(60));
    for (let i = 0; i < 22; i++) await service.logAlert('S', `alert ${i}`);
    const queued = error.mock.calls.filter(([m]) =>
      String(m).includes('queued'),
    );
    expect(queued).toHaveLength(20);
    expect(error).toHaveBeenCalledWith(
      'ALERT (S) not sent to Telegram: alert 21',
    );
  });

  it('a new alert waits behind queued ones, so they arrive in order', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const service = new TelegramLoggerService();
    fetchMock.mockImplementationOnce(() => tooMany(10));
    await service.logAlert('S', 'first');
    // The pause has ended but the queued alert hasn't been sent yet
    await jest.advanceTimersByTimeAsync(10_500);
    await service.logAlert('S', 'second');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1_000);
    const texts = fetchMock.mock.calls
      .slice(1)
      .map((c) => (c as [string, { body: string }])[1].body);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('first');
    expect(texts[1]).toContain('second');
  });

  it('never runs two drains at once (each queued alert is sent once)', async () => {
    const service = new TelegramLoggerService();
    let release!: () => void;
    fetchMock.mockImplementationOnce(() => tooMany(1)); // queues it
    await service.logAlert('S', 'only-once');
    // The drain's request hangs until released
    fetchMock.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(ok()))),
    );
    (service as unknown as { blockedUntil: number }).blockedUntil = 0;
    const first = service.flushAlerts();
    await service.flushAlerts(); // a second drain while the first is sending
    release();
    await first;
    const sent = fetchMock.mock.calls.filter(([, init]) =>
      (init as { body: string }).body.includes('only-once'),
    );
    expect(sent).toHaveLength(2); // the 429'd try + one drain send
  });

  it('a 429 without retry_after uses the Retry-After header, else 30s', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const service = new TelegramLoggerService();
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve({
        ok: false,
        status: 429,
        headers: new Headers({ 'Retry-After': '7' }),
        json: () => Promise.reject(new Error('not JSON')),
      }),
    );
    await service.logGenericAction('a', user);
    expect(warn).toHaveBeenCalledWith(
      'Telegram rate limited the log group: pausing Telegram logs for 7s',
    );

    jest.setSystemTime(1_000_000 + 8_000);
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve({
        ok: false,
        status: 429,
        json: () => Promise.resolve({ ok: false }),
      }),
    );
    await service.logGenericAction('b', user);
    expect(warn).toHaveBeenCalledWith(
      'Telegram rate limited the log group: pausing Telegram logs for 30s',
    );
  });

  it('a later, shorter 429 (a call already in flight) does not shorten the pause', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const service = new TelegramLoggerService();
    let release!: () => void;
    // two calls in flight: the 30s answer lands first, then the 15s one
    fetchMock
      .mockImplementationOnce(() => tooMany(30))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve(tooMany(15));
          }),
      );
    const first = service.setMessageReaction({ id: 2, text: 'y' }); // gets the 30s
    const second = service.logGenericAction('first', user); // still in flight
    await first;
    release(); // now the 15s answer lands
    await second;
    const pauses = warn.mock.calls.filter(([m]) =>
      String(m).startsWith('Telegram rate limited'),
    );
    expect(pauses).toHaveLength(1); // only the extension is logged

    jest.setSystemTime(1_000_000 + 20_000); // past 15s, inside 30s
    await service.logGenericAction('still paused', user);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('logs other Telegram failures as one line', async () => {
    const service = new TelegramLoggerService();
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({
            ok: false,
            description: 'Bad Request: chat not found',
          }),
      }),
    );
    await service.logGenericAction('x', user);
    expect(error).toHaveBeenCalledWith(
      'Telegram sendMessage failed (HTTP 400): Bad Request: chat not found',
    );
  });

  it('skips a reaction or edit without a message quietly', async () => {
    const service = new TelegramLoggerService();
    await service.setMessageReaction(null);
    await service.appendToMessage({ id: null, text: 'x' }, 'more');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once when the bot token or log group is missing', async () => {
    delete process.env.LOG_GROUP_ID;
    const service = new TelegramLoggerService();
    await service.logGenericAction('a', user);
    await service.logGenericAction('b', user);
    await service.setMessageReaction({ id: 1, text: 'x' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'TELEGRAM_BOT_TOKEN or LOG_GROUP_ID not configured: Telegram ops logs are off',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
