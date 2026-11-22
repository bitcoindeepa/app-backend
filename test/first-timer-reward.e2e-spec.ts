import * as request from 'supertest';
import {
  createTestApp,
  resetData,
  payhereNotification,
  sats,
  BTC_LKR,
  TestContext,
  USER,
  PACKAGE_WEEKLY,
} from './support/test-app';
import { BitcoinPriceService } from '../src/modules/bitcoin-price/bitcoin-price.service';
import { SettlementService } from '../src/modules/settlement/settlement.service';
import { TransactionService } from '../src/modules/transaction/transaction.service';

const REWARD_LKR = 500;

describe('First-timer reward (e2e)', () => {
  let ctx: TestContext;
  let orderId: string;
  const http = () => request(ctx.app.getHttpServer());
  const notify = (fields: {
    payment_id: string;
    subscription_id?: string;
    status_code?: string;
  }) =>
    http()
      .post('/transaction/payhere-webhook')
      .type('form')
      .send(payhereNotification({ order_id: orderId, ...fields }));
  const tx = (id: string) =>
    ctx.knex('transaction').where({ payhere_pay_id: id }).first();
  const user = () => ctx.knex('user').where({ id: USER }).first();
  const settle = () =>
    ctx.app.get(SettlementService).retryUnsettledTransactions();

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    delete process.env.FIRST_TIMER_REWARD_LKR;
    await ctx?.close();
  });

  beforeEach(async () => {
    process.env.FIRST_TIMER_REWARD_LKR = String(REWARD_LKR);
    await resetData(ctx);
    const res = await http()
      .post('/subscription/payhere-link')
      .set('Authorization', `Bearer ${ctx.tokenFor(USER)}`)
      .send({ package_id: PACKAGE_WEEKLY })
      .expect(201);
    orderId = new URL(res.body.link as string).searchParams.get('order_id')!;
  });

  it('adds the bonus to the first SUCCESS and sends it with the purchase in one transfer', async () => {
    await notify({ payment_id: 'P1', subscription_id: 'S1' }).expect(200);

    const p1 = await tx('P1');
    expect(Number(p1.bonus_lkr)).toBe(REWARD_LKR);
    expect(Number(p1.bonus_satoshis)).toBe(sats(REWARD_LKR));
    expect(Number(p1.satoshis_purchased)).toBe(sats(980));
    expect((await user()).first_timer_reward_payment_id).toBe('P1');

    await settle();
    expect(ctx.bitcoinDeepa.transferFunds).toHaveBeenCalledTimes(1);
    const [amount, to, memo] = ctx.bitcoinDeepa.transferFunds.mock.calls[0];
    expect(Number(amount)).toBe(sats(980) + sats(REWARD_LKR));
    expect(to).toBe(USER);
    expect(memo).toBe('DCA purchase (Ref: P1)');
    expect(await tx('P1')).toMatchObject({ settled: true });
  });

  it('gives it only once: later payments get no bonus', async () => {
    await notify({ payment_id: 'P1', subscription_id: 'S1' }).expect(200);
    await notify({ payment_id: 'P2', subscription_id: 'S1' }).expect(200);

    expect(await tx('P2')).toMatchObject({
      bonus_lkr: null,
      bonus_satoshis: null,
    });
    expect((await user()).first_timer_reward_payment_id).toBe('P1');
  });

  it('a resent SUCCESS does not change who claimed it', async () => {
    await notify({ payment_id: 'P1', subscription_id: 'S1' }).expect(200);
    await notify({ payment_id: 'P1', subscription_id: 'S1' }).expect(200);
    expect(Number((await tx('P1')).bonus_satoshis)).toBe(sats(REWARD_LKR));
  });

  it('applies on PENDING → SUCCESS, not only on a new SUCCESS row', async () => {
    await notify({
      payment_id: 'P1',
      subscription_id: 'S1',
      status_code: '0',
    }).expect(200);
    expect(await tx('P1')).toMatchObject({
      status: 'PENDING',
      bonus_lkr: null,
    });
    expect((await user()).first_timer_reward_payment_id).toBeNull();

    await notify({ payment_id: 'P1', subscription_id: 'S1' }).expect(200);
    const p1 = await tx('P1');
    expect(p1.status).toBe('SUCCESS');
    expect(Number(p1.bonus_satoshis)).toBe(sats(REWARD_LKR));
    expect((await user()).first_timer_reward_payment_id).toBe('P1');
  });

  it('only one of two first payments arriving together gets it', async () => {
    // The subscription exists (a PENDING charge doesn't count as paid)
    await notify({
      payment_id: 'P0',
      subscription_id: 'S1',
      status_code: '0',
    }).expect(200);

    await Promise.all([
      notify({ payment_id: 'P1', subscription_id: 'S1' }).expect(200),
      notify({ payment_id: 'P2', subscription_id: 'S1' }).expect(200),
    ]);

    const withBonus = await ctx
      .knex('transaction')
      .whereNotNull('bonus_lkr')
      .select('payhere_pay_id');
    expect(withBonus).toHaveLength(1);
    expect((await user()).first_timer_reward_payment_id).toBe(
      withBonus[0].payhere_pay_id,
    );
  });

  it('members who paid before the reward was on do not get it', async () => {
    delete process.env.FIRST_TIMER_REWARD_LKR;
    await notify({ payment_id: 'P1', subscription_id: 'S1' }).expect(200);
    expect(await tx('P1')).toMatchObject({ bonus_lkr: null });

    process.env.FIRST_TIMER_REWARD_LKR = String(REWARD_LKR);
    await notify({ payment_id: 'P2', subscription_id: 'S1' }).expect(200);
    expect(await tx('P2')).toMatchObject({ bonus_lkr: null });
    expect((await user()).first_timer_reward_payment_id).toBeNull();
  });

  it('is off when FIRST_TIMER_REWARD_LKR is 0', async () => {
    process.env.FIRST_TIMER_REWARD_LKR = '0';
    await notify({ payment_id: 'P1', subscription_id: 'S1' }).expect(200);
    expect(await tx('P1')).toMatchObject({ bonus_lkr: null });

    await settle();
    expect(Number(ctx.bitcoinDeepa.transferFunds.mock.calls[0][0])).toBe(
      sats(980),
    );
  });

  it('price outage: claimed but unpriced, settlement waits, the backfill prices both', async () => {
    const price = ctx.app.get(BitcoinPriceService);
    const spy = jest
      .spyOn(price, 'calculateSatoshis')
      .mockResolvedValueOnce(null);
    await notify({ payment_id: 'P1', subscription_id: 'S1' }).expect(200);
    spy.mockRestore();

    const p1 = await tx('P1');
    expect(Number(p1.bonus_lkr)).toBe(REWARD_LKR);
    expect(p1.bonus_satoshis).toBeNull();
    expect(p1.satoshis_purchased).toBeNull();

    await settle();
    expect(ctx.bitcoinDeepa.transferFunds).not.toHaveBeenCalled();

    await ctx.app.get(TransactionService).backfillMissingBitcoinData();
    expect(Number((await tx('P1')).bonus_satoshis)).toBe(sats(REWARD_LKR));

    await settle();
    expect(Number(ctx.bitcoinDeepa.transferFunds.mock.calls[0][0])).toBe(
      sats(980) + sats(REWARD_LKR),
    );
  });

  it('DCA summary: bonus is in the balance but not in spent or the average price', async () => {
    await notify({ payment_id: 'P1', subscription_id: 'S1' }).expect(200);
    const res = await http()
      .get('/transaction/dca-summary')
      .set('Authorization', `Bearer ${ctx.tokenFor(USER)}`)
      .expect(200);
    expect(res.body.dca).toMatchObject({
      balance: sats(980) + sats(REWARD_LKR),
      bonus: sats(REWARD_LKR),
      spent: 980,
    });
    // Purchased sats only: the price they were bought at. Counting the free
    // bonus sats would drag it below the market price.
    expect(res.body.dca.avg_btc_price).toBe(BTC_LKR);
  });

  it('bot history: the settlement transfer (purchase + bonus) is marked as the purchase', async () => {
    await notify({ payment_id: 'P1', subscription_id: 'S1' }).expect(200);
    ctx.bitcoinDeepa.transferFunds.mockResolvedValueOnce({
      success: true,
      payment_hash: 'h1',
    });
    await settle();

    const rows = await ctx.app
      .get(TransactionService)
      .markPurchaseSettlements(USER, [
        {
          direction: 'incoming',
          memo: 'DCA purchase (Ref: P1)',
          amount: sats(980) + sats(REWARD_LKR),
          success: true,
          payment_hash: 'h1',
        },
      ]);
    expect(rows[0].purchase_settlement).toBe(true);
  });
});
