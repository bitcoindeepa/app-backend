import * as request from 'supertest';
import { createHash, randomUUID } from 'crypto';
import {
  createTestApp,
  resetData,
  TestContext,
  USER,
  OTHER_USER,
} from './support/test-app';
import { hashToken, UNLOCK_TTL_MS } from '../src/modules/auth/session.service';
import { softPasskey, type SoftPasskey } from './support/soft-authenticator';

const ORIGIN = 'https://app.bitcoindeepa.test';
const RP_ID = 'app.bitcoindeepa.test';

describe('Passkeys (e2e)', () => {
  let ctx: TestContext;
  const http = () => request(ctx.app.getHttpServer());
  const miniApp = (userId = USER) => ({
    Authorization: `Bearer ${ctx.tokenFor(userId)}`,
  });
  const sendBody = {
    to_telegram_id: Number(OTHER_USER),
    amount: 1000,
    idempotency_key: 'passkey-test-1',
  };
  /** A route gated only by the session lock: 404 when unlocked (no such account) */
  const removeBank = (auth: Record<string, string>) =>
    http().delete(`/bank-accounts/${randomUUID()}`).set(auth);

  /** A web session (Log In with Telegram) for the user; returns its Bearer header */
  const webSession = async (userId = USER) => {
    const token = createHash('sha256')
      .update(`web-session:${userId}:${randomUUID()}`)
      .digest('base64url');
    await ctx.knex('user_session').insert({
      user_id: userId,
      token_hash: hashToken(token),
      kind: 'web',
      idle_expires_at: new Date(Date.now() + 86_400_000),
      absolute_expires_at: new Date(Date.now() + 30 * 86_400_000),
    });
    return { Authorization: `Bearer ${token}` };
  };

  /** Register a new soft passkey from this session */
  const register = async (auth: Record<string, string>, name?: string) => {
    const key = softPasskey(RP_ID);
    const options = await http()
      .post('/passkey/register/options')
      .set(auth)
      .expect(200);
    const res = await http()
      .post('/passkey/register')
      .set(auth)
      .send({ response: key.create(options.body, ORIGIN), name })
      .expect(200);
    return { key, status: res.body };
  };

  const unlock = async (
    auth: Record<string, string>,
    key: SoftPasskey,
    expected = 200,
  ) => {
    const options = await http()
      .post('/passkey/unlock/options')
      .set(auth)
      .expect(200);
    return http()
      .post('/passkey/unlock')
      .set(auth)
      .send({ response: key.get(options.body, ORIGIN) })
      .expect(expected);
  };

  /** An approval for one action, as the X-Passkey-Assertion header */
  const approve = async (
    auth: Record<string, string>,
    key: SoftPasskey,
    action: Record<string, unknown>,
  ) => {
    const options = await http()
      .post('/passkey/approve/options')
      .set(auth)
      .send(action)
      .expect(200);
    const assertion = key.get(options.body, ORIGIN);
    return {
      'X-Passkey-Assertion': Buffer.from(JSON.stringify(assertion)).toString(
        'base64url',
      ),
    };
  };
  const sendAction = (body = sendBody) => ({ action: 'p2p_send', ...body });

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx?.close());
  beforeEach(async () => {
    process.env.APP_URL = ORIGIN;
    await resetData(ctx);
    ctx.p2pBot.isConfigured.mockReturnValue(true);
    ctx.p2pBot.request.mockReset();
    ctx.p2pBot.request.mockResolvedValue({
      status: 200,
      body: { status: 'completed' },
    });
  });
  afterEach(() => {
    delete process.env.APP_URL;
    delete process.env.WEBAUTHN_RP_ID;
  });

  describe('lock and settings', () => {
    it('is off by default; without one the web app can read but not send', async () => {
      const web = await webSession();
      const res = await http().get('/passkey').set(web).expect(200);
      expect(res.body).toEqual({
        enabled: false,
        unlocked: true,
        available: true,
        passkeys: [],
      });
      await removeBank(web).expect(404);
      const send = await http()
        .post('/p2p/send')
        .set(web)
        .send(sendBody)
        .expect(403);
      expect(send.body.code).toBe('passkey_setup_required');
      const options = await http()
        .post('/passkey/approve/options')
        .set(web)
        .send(sendAction())
        .expect(403);
      expect(options.body.code).toBe('passkey_setup_required');
      await http().get('/passkey').expect(401);
    });

    it('registers a passkey bound to the RP ID, storing only its public key', async () => {
      const web = await webSession();
      const options = await http()
        .post('/passkey/register/options')
        .set(web)
        .expect(200);
      expect(options.body.rp).toEqual({ id: RP_ID, name: 'Bitcoin Deepa' });
      expect(options.body.authenticatorSelection.userVerification).toBe(
        'required',
      );
      // The user handle isn't the Telegram id
      expect(
        Buffer.from(options.body.user.id, 'base64url').toString(),
      ).not.toContain(USER);

      const key = softPasskey(RP_ID);
      const res = await http()
        .post('/passkey/register')
        .set(web)
        .send({ response: key.create(options.body, ORIGIN), name: 'MacBook' })
        .expect(200);
      expect(res.body).toMatchObject({ enabled: true, unlocked: true });
      expect(res.body.passkeys).toEqual([
        expect.objectContaining({ name: 'MacBook', last_used_at: null }),
      ]);
      const row = await ctx
        .knex('user_passkey')
        .where({ user_id: USER })
        .first();
      expect(row.credential_id).toBe(key.credentialId);
      expect(Buffer.isBuffer(row.public_key)).toBe(true);

      // The challenge was used up: the same response can't register twice
      const replay = await http()
        .post('/passkey/register')
        .set(web)
        .send({ response: key.create(options.body, ORIGIN) })
        .expect(400);
      expect(replay.body.code).toBe('challenge_expired');
    });

    it('refuses a response from another origin or for another challenge', async () => {
      const web = await webSession();
      const key = softPasskey(RP_ID);
      let options = await http()
        .post('/passkey/register/options')
        .set(web)
        .expect(200);
      const phishing = await http()
        .post('/passkey/register')
        .set(web)
        .send({ response: key.create(options.body, 'https://evil.test') })
        .expect(400);
      expect(phishing.body.code).toBe('passkey_not_verified');

      options = await http()
        .post('/passkey/register/options')
        .set(web)
        .expect(200);
      const forged = await http()
        .post('/passkey/register')
        .set(web)
        .send({
          response: key.create({ challenge: 'bm90LXRoaXMtb25l' }, ORIGIN),
        })
        .expect(400);
      expect(forged.body.code).toBe('passkey_not_verified');
      expect(await ctx.knex('user_passkey').count('* as n').first()).toEqual({
        n: '0',
      });
    });

    it('locks other web sessions until they unlock; gated routes answer 403 passkey_required', async () => {
      const laptop = await webSession();
      const browser = await webSession();
      const { key } = await register(laptop);

      // The session that registered stays unlocked
      await removeBank(laptop).expect(404);

      const status = await http().get('/passkey').set(browser).expect(200);
      expect(status.body).toMatchObject({ enabled: true, unlocked: false });
      const refused = await removeBank(browser).expect(403);
      expect(refused.body.code).toBe('passkey_required');
      // Reads still work
      await http().get('/user/me').set(browser).expect(200);

      const unlocked = await unlock(browser, key);
      expect(unlocked.body.unlocked).toBe(true);
      await removeBank(browser).expect(404);
      const row = await ctx
        .knex('user_passkey')
        .where({ user_id: USER })
        .first();
      expect(Number(row.counter)).toBe(1);
      expect(row.last_used_at).not.toBeNull();
    });

    it('never locks the Mini App, which also cannot manage passkeys or needs approvals', async () => {
      const web = await webSession();
      await register(web);

      await http().post('/p2p/send').set(miniApp()).send(sendBody).expect(200);
      await removeBank(miniApp()).expect(404);
      const status = await http().get('/passkey').set(miniApp()).expect(200);
      expect(status.body).toMatchObject({
        enabled: true,
        unlocked: true,
        available: false,
      });
      const refused = await http()
        .post('/passkey/register/options')
        .set(miniApp())
        .expect(403);
      expect(refused.body.code).toBe('passkey_unavailable');
    });

    it('locks again once the unlock is older than the TTL', async () => {
      const web = await webSession();
      await register(web);
      await ctx
        .knex('user_session')
        .where({ user_id: USER, kind: 'web' })
        .update({ unlocked_at: new Date(Date.now() - UNLOCK_TTL_MS - 1000) });
      const res = await removeBank(web).expect(403);
      expect(res.body.code).toBe('passkey_required');
    });

    it("refuses another member's passkey, a reused challenge and a wrong RP", async () => {
      const mine = await webSession();
      const theirs = await webSession(OTHER_USER);
      await register(mine);
      const { key: otherKey } = await register(theirs);

      const browser = await webSession();
      const options = await http()
        .post('/passkey/unlock/options')
        .set(browser)
        .expect(200);
      await http()
        .post('/passkey/unlock')
        .set(browser)
        .send({ response: otherKey.get(options.body, ORIGIN) })
        .expect(400);

      // The challenge is gone after one try, even a failed one
      const again = await http()
        .post('/passkey/unlock')
        .set(browser)
        .send({ response: otherKey.get(options.body, ORIGIN) })
        .expect(400);
      expect(again.body.code).toBe('challenge_expired');

      const { key } = await register(mine, 'second');
      const wrongRp = await http()
        .post('/passkey/unlock/options')
        .set(browser)
        .expect(200);
      await http()
        .post('/passkey/unlock')
        .set(browser)
        .send({
          response: key.get(wrongRp.body, ORIGIN, { rpId: 'evil.test' }),
        })
        .expect(400);
      await removeBank(browser).expect(403);
    });

    it('needs an unlocked session to add another passkey or remove one', async () => {
      const laptop = await webSession();
      const { key, status } = await register(laptop);
      const browser = await webSession();

      const add = await http()
        .post('/passkey/register/options')
        .set(browser)
        .expect(403);
      expect(add.body.code).toBe('passkey_required');
      const id = status.passkeys[0].id;
      await http().delete(`/passkey/${id}`).set(browser).expect(403);

      await unlock(browser, key);
      await register(browser, 'Phone');
      const list = await http().get('/passkey').set(browser).expect(200);
      expect(list.body.passkeys.map((p: { name: string }) => p.name)).toEqual([
        'Passkey',
        'Phone',
      ]);

      // Removing every passkey turns the lock off (and sending needs one again)
      for (const p of list.body.passkeys) {
        await http().delete(`/passkey/${p.id}`).set(browser).expect(200);
      }
      const other = await webSession();
      const off = await http().get('/passkey').set(other).expect(200);
      expect(off.body).toMatchObject({ enabled: false, unlocked: true });
      await removeBank(other).expect(404);
      const send = await http()
        .post('/p2p/send')
        .set(other)
        .send(sendBody)
        .expect(403);
      expect(send.body.code).toBe('passkey_setup_required');
    });

    it('uses WEBAUTHN_RP_ID when set', async () => {
      process.env.WEBAUTHN_RP_ID = 'bitcoindeepa.test';
      const web = await webSession();
      const options = await http()
        .post('/passkey/register/options')
        .set(web)
        .expect(200);
      expect(options.body.rp.id).toBe('bitcoindeepa.test');
      const key = softPasskey('bitcoindeepa.test');
      await http()
        .post('/passkey/register')
        .set(web)
        .send({ response: key.create(options.body, ORIGIN) })
        .expect(200);
    });

    it('support can remove them with the admin key', async () => {
      const web = await webSession();
      await register(web);
      await http().post(`/passkey/admin-reset/${USER}`).expect(403);
      const res = await http()
        .post(`/passkey/admin-reset/${USER}`)
        .set('x-admin-key', process.env.ADMIN_API_KEY!)
        .expect(200);
      expect(res.body).toEqual({ removed: 1 });
      await http()
        .post(`/passkey/admin-reset/${USER}`)
        .set('x-admin-key', process.env.ADMIN_API_KEY!)
        .expect(404);
    });

    it('a legacy JWT can neither use passkeys nor spend once one is set', async () => {
      const legacy = { Authorization: `Bearer ${ctx.legacyTokenFor(USER)}` };
      const res = await http().get('/passkey').set(legacy).expect(403);
      expect(res.body.code).toBe('relogin_required');
      await register(await webSession());
      const bank = await removeBank(legacy).expect(403);
      expect(bank.body.code).toBe('relogin_required');
    });
  });

  describe('approving sends and sale payments (web)', () => {
    it('sends with an approval for exactly that send, once', async () => {
      const web = await webSession();
      const { key } = await register(web);

      const missing = await http()
        .post('/p2p/send')
        .set(web)
        .send(sendBody)
        .expect(403);
      expect(missing.body.code).toBe('passkey_approval_required');
      expect(ctx.p2pBot.request).not.toHaveBeenCalled();

      const approval = await approve(web, key, sendAction());
      await http()
        .post('/p2p/send')
        .set(web)
        .set(approval)
        .send(sendBody)
        .expect(200);
      expect(ctx.p2pBot.request).toHaveBeenCalledTimes(1);

      // Used up: the same approval can't send again
      const replay = await http()
        .post('/p2p/send')
        .set(web)
        .set(approval)
        .send(sendBody)
        .expect(403);
      expect(replay.body.code).toBe('passkey_approval_required');
      expect(ctx.p2pBot.request).toHaveBeenCalledTimes(1);
    });

    it('refuses an approval for another amount, recipient or payment key', async () => {
      const web = await webSession();
      const { key } = await register(web);
      for (const changed of [
        { ...sendBody, amount: 99_000 },
        { ...sendBody, to_telegram_id: 100000099 },
        { ...sendBody, idempotency_key: 'another-payment' },
      ]) {
        const approval = await approve(web, key, sendAction());
        const res = await http()
          .post('/p2p/send')
          .set(web)
          .set(approval)
          .send(changed)
          .expect(403);
        expect(res.body.code).toBe('passkey_approval_required');
      }
      expect(ctx.p2pBot.request).not.toHaveBeenCalled();
    });

    it("refuses another member's passkey, a malformed header and a wrong origin", async () => {
      const web = await webSession();
      const { key } = await register(web);
      const { key: otherKey } = await register(await webSession(OTHER_USER));

      let options = await http()
        .post('/passkey/approve/options')
        .set(web)
        .send(sendAction())
        .expect(200);
      const foreign = Buffer.from(
        JSON.stringify(otherKey.get(options.body, ORIGIN)),
      ).toString('base64url');
      await http()
        .post('/p2p/send')
        .set(web)
        .set('X-Passkey-Assertion', foreign)
        .send(sendBody)
        .expect(400);

      await http()
        .post('/p2p/send')
        .set(web)
        .set('X-Passkey-Assertion', 'not-json')
        .send(sendBody)
        .expect(403);

      options = await http()
        .post('/passkey/approve/options')
        .set(web)
        .send(sendAction())
        .expect(200);
      const phished = Buffer.from(
        JSON.stringify(key.get(options.body, 'https://evil.test')),
      ).toString('base64url');
      await http()
        .post('/p2p/send')
        .set(web)
        .set('X-Passkey-Assertion', phished)
        .send(sendBody)
        .expect(400);
      expect(ctx.p2pBot.request).not.toHaveBeenCalled();
    });

    it('approves from a locked session too, and unlocks it', async () => {
      const laptop = await webSession();
      const { key } = await register(laptop);
      const browser = await webSession();
      await removeBank(browser).expect(403);

      const approval = await approve(browser, key, sendAction());
      await http()
        .post('/p2p/send')
        .set(browser)
        .set(approval)
        .send(sendBody)
        .expect(200);
      await removeBank(browser).expect(404);
    });

    it('needs an approval for that order to pay a sale', async () => {
      const web = await webSession();
      const { key } = await register(web);
      const orderId = randomUUID();

      const missing = await http()
        .post(`/sell/orders/${orderId}/pay`)
        .set(web)
        .expect(403);
      expect(missing.body.code).toBe('passkey_approval_required');

      const forOther = await approve(web, key, {
        action: 'sell_pay',
        order_id: randomUUID(),
      });
      await http()
        .post(`/sell/orders/${orderId}/pay`)
        .set(web)
        .set(forOther)
        .expect(403);

      // The right approval gets past the guard (no such order: 404)
      const approval = await approve(web, key, {
        action: 'sell_pay',
        order_id: orderId,
      });
      await http()
        .post(`/sell/orders/${orderId}/pay`)
        .set(web)
        .set(approval)
        .expect(404);

      // The Mini App pays without one
      await http()
        .post(`/sell/orders/${orderId}/pay`)
        .set(miniApp())
        .expect(404);
    });

    it('validates the approval request', async () => {
      const web = await webSession();
      await register(web);
      await http()
        .post('/passkey/approve/options')
        .set(web)
        .send({ action: 'p2p_send', amount: 1000 })
        .expect(400);
      await http()
        .post('/passkey/approve/options')
        .set(web)
        .send({ action: 'withdraw_everything' })
        .expect(400);
      const mini = await http()
        .post('/passkey/approve/options')
        .set(miniApp())
        .send(sendAction())
        .expect(403);
      expect(mini.body.code).toBe('passkey_unavailable');
    });
  });
});
