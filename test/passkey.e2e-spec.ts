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
import { softPasskey } from './support/soft-authenticator';

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
    key: ReturnType<typeof softPasskey>,
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

  it('is off by default and never blocks a member without one', async () => {
    const web = await webSession();
    const res = await http().get('/passkey').set(web).expect(200);
    expect(res.body).toEqual({
      enabled: false,
      unlocked: true,
      available: true,
      passkeys: [],
    });
    await http().post('/p2p/send').set(web).send(sendBody).expect(200);
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
    const row = await ctx.knex('user_passkey').where({ user_id: USER }).first();
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
      .send({ response: key.create({ challenge: 'bm90LXRoaXMtb25l' }, ORIGIN) })
      .expect(400);
    expect(forged.body.code).toBe('passkey_not_verified');
    expect(await ctx.knex('user_passkey').count('* as n').first()).toEqual({
      n: '0',
    });
  });

  it('locks other web sessions until they unlock; money routes answer 403 passkey_required', async () => {
    const laptop = await webSession();
    const browser = await webSession();
    const { key } = await register(laptop);

    // The session that registered stays unlocked
    await http().post('/p2p/send').set(laptop).send(sendBody).expect(200);

    const status = await http().get('/passkey').set(browser).expect(200);
    expect(status.body).toMatchObject({ enabled: true, unlocked: false });
    ctx.p2pBot.request.mockClear();
    const refused = await http()
      .post('/p2p/send')
      .set(browser)
      .send(sendBody)
      .expect(403);
    expect(refused.body.code).toBe('passkey_required');
    expect(ctx.p2pBot.request).not.toHaveBeenCalled();
    const bank = await http()
      .delete(`/bank-accounts/${randomUUID()}`)
      .set(browser)
      .expect(403);
    expect(bank.body.code).toBe('passkey_required');
    // Reads still work
    await http().get('/user/me').set(browser).expect(200);

    const unlocked = await unlock(browser, key);
    expect(unlocked.body.unlocked).toBe(true);
    await http().post('/p2p/send').set(browser).send(sendBody).expect(200);
    const row = await ctx.knex('user_passkey').where({ user_id: USER }).first();
    expect(Number(row.counter)).toBe(1);
    expect(row.last_used_at).not.toBeNull();
  });

  it('never locks the Mini App, which also cannot manage passkeys', async () => {
    const web = await webSession();
    await register(web);

    await http().post('/p2p/send').set(miniApp()).send(sendBody).expect(200);
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
    const res = await http()
      .post('/p2p/send')
      .set(web)
      .send(sendBody)
      .expect(403);
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
    await http().post('/p2p/send').set(browser).send(sendBody).expect(403);
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

    // Removing every passkey turns the lock off
    for (const p of list.body.passkeys) {
      await http().delete(`/passkey/${p.id}`).set(browser).expect(200);
    }
    const locked = await webSession();
    const off = await http().get('/passkey').set(locked).expect(200);
    expect(off.body).toMatchObject({ enabled: false, unlocked: true });
    await http().post('/p2p/send').set(locked).send(sendBody).expect(200);
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
    const bank = await http()
      .delete(`/bank-accounts/${randomUUID()}`)
      .set(legacy)
      .expect(403);
    expect(bank.body.code).toBe('relogin_required');
  });
});
