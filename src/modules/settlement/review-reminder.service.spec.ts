import { ReviewReminderService } from './review-reminder.service';
import { truncateText } from '../telegram-logger/telegram-logger.service';

/** A knex stub: every query on a table resolves to its rows, counts to `total` */
function knexStub(tables: Record<string, Record<string, unknown>[]>) {
  return {
    knex: (table: string) => {
      const rows = tables[table] ?? [];
      const builder: Record<string, unknown> = {};
      for (const m of [
        'where',
        'whereRaw',
        'whereNull',
        'whereNotNull',
        'select',
        'orderBy',
      ]) {
        builder[m] = () => builder;
      }
      builder.limit = (n: number) => Promise.resolve(rows.slice(0, n));
      builder.count = () => Promise.resolve([{ total: String(rows.length) }]);
      return builder;
    },
  };
}

describe('ReviewReminderService', () => {
  const longReason = 'Upstream error: '.padEnd(10_000, 'x<&>');

  it('keeps the plain reminder under 4096 characters with long stored reasons', async () => {
    const sales = Array.from({ length: 12 }, (_, i) => ({
      id: `00000000-0000-0000-0000-00000000000${i}`,
      user_id: '1234567890',
      sats: '5000000',
      amount_lkr: '123456.78',
      failure_reason: longReason,
    }));
    const held = Array.from({ length: 12 }, (_, i) => ({
      payhere_pay_id: `32000000000${i}`,
      user_id: '1234567890',
      gross_amount: '100000.00',
      hold_reason: longReason,
    }));
    const logAlert = jest.fn().mockResolvedValue(undefined);
    const service = new ReviewReminderService(
      knexStub({ sell_order: sales, transaction: held }) as never,
      { setIfAbsent: jest.fn().mockResolvedValue(true) } as never,
      { logAlert } as never,
    );

    await service.remind();

    expect(logAlert).toHaveBeenCalledTimes(1);
    const [, text, details] = logAlert.mock.calls[0] as [
      string,
      string,
      { richHtml: string },
    ];
    // well under the limit before logAlert adds its heading
    expect(text.length).toBeLessThan(4000);
    // every group is still there, with its "and N more"
    expect(text).toContain('Sales in NEEDS_REVIEW (');
    expect(text).toContain('Held one-time buys (');
    expect(text).toContain('Paid but not settled');
    expect(text).toContain('- and 4 more');
    expect(text).not.toContain(longReason);
    expect(details.richHtml).not.toContain('xxxx'.repeat(100));
  });
});

describe('truncateText', () => {
  it('leaves short text alone and cuts long text with an ellipsis', () => {
    expect(truncateText('short', 10)).toBe('short');
    expect(truncateText('abcdefghij', 5)).toBe('abcd…');
  });

  it('never splits a character made of two UTF-16 units', () => {
    const cut = truncateText('a😀😀😀', 3);
    expect(cut).toBe('a…');
    expect(cut.length).toBeLessThanOrEqual(3);
  });
});
