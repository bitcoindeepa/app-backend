import {
  createTestApp,
  resetData,
  TestContext,
  USER,
} from './support/test-app';

// The set_updated_at() trigger (#110): updated_at follows real changes on
// the tables that have it, and sell_order keeps its hand-set updated_at.
describe('updated_at trigger (e2e)', () => {
  let ctx: TestContext;
  const LONG_AGO = new Date('2020-01-01T00:00:00Z');

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx?.close());
  beforeEach(() => resetData(ctx));

  const updatedAt = async (table: string, where: Record<string, unknown>) =>
    (
      await ctx
        .knex(table)
        .where(where)
        .first<{ updated_at: Date }>('updated_at')
    ).updated_at;

  it('moves transaction.updated_at on a status change', async () => {
    // Inserts aren't triggered: start it long ago, like a stale row
    await ctx.knex('transaction').insert({
      payhere_pay_id: 'P-UPD',
      user_id: USER,
      status: 'PENDING',
      created_at: LONG_AGO,
      updated_at: LONG_AGO,
    });

    await ctx
      .knex('transaction')
      .where('payhere_pay_id', 'P-UPD')
      .update({ status: 'SUCCESS' });

    const after = await updatedAt('transaction', { payhere_pay_id: 'P-UPD' });
    expect(after.getTime()).toBeGreaterThan(LONG_AGO.getTime());
    // created_at is left alone
    const row = await ctx
      .knex('transaction')
      .where('payhere_pay_id', 'P-UPD')
      .first<{ created_at: Date }>('created_at');
    expect(row.created_at).toEqual(LONG_AGO);
  });

  it('leaves it alone on an update that changes nothing', async () => {
    await ctx.knex('transaction').insert({
      payhere_pay_id: 'P-SAME',
      user_id: USER,
      status: 'SUCCESS',
      created_at: LONG_AGO,
      updated_at: LONG_AGO,
    });

    await ctx
      .knex('transaction')
      .where('payhere_pay_id', 'P-SAME')
      .update({ status: 'SUCCESS' });

    expect(
      await updatedAt('transaction', { payhere_pay_id: 'P-SAME' }),
    ).toEqual(LONG_AGO);
  });

  it('moves user.updated_at, which nothing set before', async () => {
    await ctx
      .knex('user')
      .insert({ id: '100000099', first_name: 'Old', updated_at: LONG_AGO });

    await ctx
      .knex('user')
      .where('id', '100000099')
      .update({ tg_username: 'new_name' });

    const after = await updatedAt('user', { id: '100000099' });
    expect(after.getTime()).toBeGreaterThan(LONG_AGO.getTime());
  });

  it('is on every table that has updated_at except sell_order and the Better Auth tables', async () => {
    const { rows } = await ctx.knex.raw<{
      rows: { table_name: string }[];
    }>(
      `SELECT c.relname AS table_name
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE t.tgname LIKE '%_set_updated_at' AND NOT t.tgisinternal
        ORDER BY 1`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'buy_order',
      'package',
      'subscription',
      'transaction',
      'user',
      'user_bank_account',
    ]);
  });
});
