import { randomUUID } from 'crypto';
import * as request from 'supertest';
import {
  createTestApp,
  OTHER_USER,
  resetData,
  TestContext,
  USER,
} from './support/test-app';
import { ADMIN_ORIGIN, signInAdmin } from './support/admin-session';
import {
  ACCOUNT,
  asAdmin,
  asUser,
  submitBankAccount,
} from './support/bank-account-helpers';
import { TelegramLoggerService } from '../src/modules/telegram-logger/telegram-logger.service';

describe('Bank account verification (e2e)', () => {
  let ctx: TestContext;
  let cookies: string[];
  const account = (id: string) =>
    ctx.knex('user_bank_account').where({ id }).first();

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.close());

  beforeEach(async () => {
    await resetData(ctx);
    cookies = await signInAdmin(ctx);
  });

  describe('submitting', () => {
    it('gives a temporary upload URL for the statement, under the user', async () => {
      const res = await asUser(ctx, USER)
        .post('/bank-accounts/statement-upload', {
          contentType: 'image/png',
          size: 2048,
        })
        .expect(201);
      expect(res.body.key).toMatch(
        new RegExp(`^bank-statements/${USER}/[0-9a-f-]{36}\\.png$`),
      );
      expect(res.body.method).toBe('PUT');
      expect(res.body.headers).toEqual({ 'Content-Type': 'image/png' });
      expect(ctx.storage.presignUpload).toHaveBeenCalledWith(
        res.body.key,
        'image/png',
        2048,
      );
    });

    it('rejects files that are too big or of the wrong type', async () => {
      const user = asUser(ctx, USER);
      await user
        .post('/bank-accounts/statement-upload', {
          contentType: 'application/pdf',
          size: 9 * 1024 * 1024,
        })
        .expect(400);
      await user
        .post('/bank-accounts/statement-upload', {
          contentType: 'text/html',
          size: 100,
        })
        .expect(400);
    });

    it('stores the account as PENDING_REVIEW with a name-match hint', async () => {
      const alert = jest.spyOn(ctx.app.get(TelegramLoggerService), 'logAlert');
      const id = await submitBankAccount(ctx, USER);
      // the review link defaults to the first ADMIN_APP_URL origin
      expect(alert).toHaveBeenCalledWith(
        'Bank review',
        expect.stringContaining(`${ADMIN_ORIGIN}/bank-reviews`),
      );
      alert.mockRestore();
      const row = await account(id);
      expect(row).toMatchObject({
        user_id: USER,
        bank_code: 7010,
        bank_name: 'Bank of Ceylon',
        account_number: '1234567890',
        account_name: 'T. User',
        status: 'PENDING_REVIEW',
      });
      // "T. User" vs profile "Test User": initial + surname
      expect(Number(row.name_match_score)).toBe(1);

      const list = await asUser(ctx, USER).get('/bank-accounts').expect(200);
      expect(list.body).toEqual([
        expect.objectContaining({
          id,
          status: 'PENDING_REVIEW',
          accountNumber: '••••••7890',
        }),
      ]);
    });

    it('scores the account name against the verified ID name, not the Telegram name', async () => {
      // the member renamed their Telegram profile to match someone else's account
      await ctx
        .knex('user')
        .where({ id: USER })
        .update({ kyc_full_name: 'Nimal Silva' });
      const id = await submitBankAccount(ctx, USER);
      expect(Number((await account(id)).name_match_score)).toBeLessThan(0.5);
      const res = await asAdmin(ctx, cookies)
        .get('/admin/bank-reviews')
        .expect(200);
      expect(res.body.items[0]).toMatchObject({
        memberName: 'Test User',
        verifiedName: 'Nimal Silva',
      });
    });

    it('fetches a missing verified name from Didit and keeps it', async () => {
      await ctx
        .knex('user')
        .where({ id: USER })
        .update({ kyc_full_name: null, kyc_session_id: 'sess-1' });
      ctx.didit.getSession.mockResolvedValueOnce({
        status: 'Approved',
        url: null,
        verifiedName: 'Test User',
      });
      const id = await submitBankAccount(ctx, USER);
      expect(ctx.didit.getSession).toHaveBeenCalledWith('sess-1');
      expect(Number((await account(id)).name_match_score)).toBe(1);
      const user = await ctx.knex('user').where({ id: USER }).first();
      expect(user.kyc_full_name).toBe('Test User');
    });

    it('refuses a submission when the verified name is unknown', async () => {
      await ctx
        .knex('user')
        .where({ id: USER })
        .update({ kyc_full_name: null, kyc_session_id: 'sess-1' });
      const user = asUser(ctx, USER);
      const upload = await user
        .post('/bank-accounts/statement-upload', {
          contentType: 'application/pdf',
          size: 120_000,
        })
        .expect(201);
      await user
        .post('/bank-accounts', {
          ...ACCOUNT,
          statementKey: upload.body.key as string,
        })
        .expect(503);
      expect(await ctx.knex('user_bank_account').count()).toEqual([
        { count: '0' },
      ]);
    });

    it('requires KYC', async () => {
      await asUser(ctx, OTHER_USER)
        .post('/bank-accounts/statement-upload', {
          contentType: 'application/pdf',
          size: 100,
        })
        .expect(403);
      await asUser(ctx, OTHER_USER)
        .post('/bank-accounts', {
          ...ACCOUNT,
          statementKey: `bank-statements/${OTHER_USER}/00000000-0000-4000-8000-000000000000.pdf`,
        })
        .expect(403);
    });

    it("refuses someone else's statement or a missing upload", async () => {
      const user = asUser(ctx, USER);
      await user
        .post('/bank-accounts', {
          ...ACCOUNT,
          statementKey: `bank-statements/${OTHER_USER}/00000000-0000-4000-8000-000000000000.pdf`,
        })
        .expect(400);

      ctx.storage.head.mockResolvedValueOnce(null);
      await user
        .post('/bank-accounts', {
          ...ACCOUNT,
          statementKey: `bank-statements/${USER}/00000000-0000-4000-8000-000000000000.pdf`,
        })
        .expect(400);
    });

    it('checks the uploaded file, not what the client claimed', async () => {
      ctx.storage.head.mockResolvedValueOnce({
        size: 50 * 1024 * 1024,
        contentType: 'application/pdf',
      });
      await asUser(ctx, USER)
        .post('/bank-accounts', {
          ...ACCOUNT,
          statementKey: `bank-statements/${USER}/00000000-0000-4000-8000-000000000000.pdf`,
        })
        .expect(400);
    });

    it('rejects an unknown bank and a bad account number', async () => {
      const key = `bank-statements/${USER}/00000000-0000-4000-8000-000000000000.pdf`;
      await asUser(ctx, USER)
        .post('/bank-accounts', {
          ...ACCOUNT,
          bankCode: 9999,
          statementKey: key,
        })
        .expect(400);
      await asUser(ctx, USER)
        .post('/bank-accounts', {
          ...ACCOUNT,
          accountNumber: '12ab',
          statementKey: key,
        })
        .expect(400);
    });

    it('allows only one account in review or verified', async () => {
      await submitBankAccount(ctx, USER);
      const upload = await asUser(ctx, USER)
        .post('/bank-accounts/statement-upload', {
          contentType: 'application/pdf',
          size: 100,
        })
        .expect(201);
      await asUser(ctx, USER)
        .post('/bank-accounts', {
          ...ACCOUNT,
          accountNumber: '999999999',
          statementKey: upload.body.key as string,
        })
        .expect(409);
    });
  });

  describe('admin review', () => {
    it('refuses an approve from another origin (CSRF)', async () => {
      const id = await submitBankAccount(ctx, USER);
      await request(ctx.app.getHttpServer())
        .post(`/admin/bank-reviews/${id}/approve`)
        .set('Origin', 'https://evil.example')
        .set('Cookie', cookies)
        .expect(403);
      expect((await account(id)).status).toBe('PENDING_REVIEW');
    });

    it("refuses to approve when the member's KYC is no longer approved", async () => {
      const id = await submitBankAccount(ctx, USER);
      await ctx
        .knex('user')
        .where({ id: USER })
        .update({ kyc_status: 'DECLINED' });
      await asAdmin(ctx, cookies)
        .post(`/admin/bank-reviews/${id}/approve`)
        .expect(409);
      expect((await account(id)).status).toBe('PENDING_REVIEW');
      expect(ctx.ceyPay.upsertUser).not.toHaveBeenCalled();
    });

    it('needs an admin session', async () => {
      const id = await submitBankAccount(ctx, USER);
      await request(ctx.app.getHttpServer())
        .post(`/admin/bank-reviews/${id}/approve`)
        .set('Origin', ADMIN_ORIGIN)
        .expect(401);
      await request(ctx.app.getHttpServer())
        .get('/admin/bank-reviews')
        .set('Origin', ADMIN_ORIGIN)
        .expect(401);
    });

    it('lists pending accounts with the member name and match score', async () => {
      const id = await submitBankAccount(ctx, USER);
      const res = await asAdmin(ctx, cookies)
        .get('/admin/bank-reviews')
        .expect(200);
      expect(res.body).toMatchObject({ total: 1, page: 1 });
      expect(res.body.items[0]).toMatchObject({
        id,
        userId: USER,
        memberName: 'Test User',
        verifiedName: 'Test User',
        kycStatus: 'APPROVED',
        accountName: 'T. User',
        accountNumber: '1234567890',
        nameMatchScore: 1,
        status: 'PENDING_REVIEW',
      });
      const count = await asAdmin(ctx, cookies)
        .get('/admin/bank-reviews/pending-count')
        .expect(200);
      expect(count.body).toEqual({ pending: 1 });
    });

    it('gives a temporary link to the statement', async () => {
      const id = await submitBankAccount(ctx, USER);
      const row = await account(id);
      const res = await asAdmin(ctx, cookies)
        .get(`/admin/bank-reviews/${id}/statement`)
        .expect(200);
      expect(ctx.storage.presignDownload).toHaveBeenCalledWith(
        row.statement_key,
      );
      expect(res.body.url).toContain(row.statement_key);
    });

    it('approving registers the account with CeyPay and verifies it', async () => {
      const id = await submitBankAccount(ctx, USER);
      await asAdmin(ctx, cookies)
        .post(`/admin/bank-reviews/${id}/approve`)
        .expect(200, { id, status: 'VERIFIED' });

      expect(ctx.ceyPay.upsertUser).toHaveBeenCalledWith(USER);
      expect(ctx.ceyPay.addBankAccount).toHaveBeenCalledWith(
        expect.any(String),
        {
          bankCode: 7010,
          accountNumber: '1234567890',
          accountName: 'T. User',
        },
      );
      const row = await account(id);
      expect(row.status).toBe('VERIFIED');
      expect(row.ceypay_user_bank_id).toEqual(expect.any(String));
      expect(row.reviewed_by).toBe('admin:admin@example.com');
      const user = await ctx.knex('user').where({ id: USER }).first();
      expect(user.ceypay_user_id).toEqual(expect.any(String));
      expect(ctx.notifyUser).toHaveBeenCalledWith(
        USER,
        expect.stringContaining('verified'),
      );

      // a second approve is a conflict, not a second CeyPay registration
      await asAdmin(ctx, cookies)
        .post(`/admin/bank-reviews/${id}/approve`)
        .expect(409);
      expect(ctx.ceyPay.addBankAccount).toHaveBeenCalledTimes(1);
    });

    it('keeps the account pending when CeyPay fails, and it can be approved again at once', async () => {
      const id = await submitBankAccount(ctx, USER);
      ctx.ceyPay.addBankAccount.mockRejectedValueOnce(new Error('CeyPay down'));
      await asAdmin(ctx, cookies)
        .post(`/admin/bank-reviews/${id}/approve`)
        .expect(502);
      const row = await account(id);
      expect(row.status).toBe('PENDING_REVIEW');
      expect(row.approving_at).toBeNull(); // the claim was given back

      await asAdmin(ctx, cookies)
        .post(`/admin/bank-reviews/${id}/approve`)
        .expect(200, { id, status: 'VERIFIED' });
    });

    // #97: nothing is held while CeyPay answers (up to 10s per call)
    describe('while CeyPay is being called', () => {
      const registered = (a: {
        bankCode: number;
        accountNumber: string;
        accountName: string;
      }) => ({ userBankId: randomUUID(), ...a, bankName: 'Bank' });

      it("doesn't lock the member's user row", async () => {
        const id = await submitBankAccount(ctx, USER);
        ctx.ceyPay.addBankAccount.mockImplementationOnce(
          async (_userId: string, a: Parameters<typeof registered>[0]) => {
            // A login updating the member's row; it used to wait for the
            // approve's FOR UPDATE and time out here
            await ctx.knex.transaction(async (trx) => {
              await trx.raw("SET LOCAL lock_timeout = '1s'");
              await trx('user')
                .where({ id: USER })
                .update({ tg_username: 'during_approve' });
            });
            return registered(a);
          },
        );
        await asAdmin(ctx, cookies)
          .post(`/admin/bank-reviews/${id}/approve`)
          .expect(200, { id, status: 'VERIFIED' });
        expect(
          (await ctx.knex('user').where({ id: USER }).first()).tg_username,
        ).toBe('during_approve');
      });

      it('answers a second approve with 409 instead of registering twice', async () => {
        const id = await submitBankAccount(ctx, USER);
        let second = 0;
        ctx.ceyPay.addBankAccount.mockImplementationOnce(
          async (_userId: string, a: Parameters<typeof registered>[0]) => {
            second = (
              await asAdmin(ctx, cookies).post(
                `/admin/bank-reviews/${id}/approve`,
              )
            ).status;
            return registered(a);
          },
        );
        await asAdmin(ctx, cookies)
          .post(`/admin/bank-reviews/${id}/approve`)
          .expect(200, { id, status: 'VERIFIED' });
        expect(second).toBe(409);
        expect(ctx.ceyPay.addBankAccount).toHaveBeenCalledTimes(1);
      });

      it("doesn't verify if the member's KYC is revoked meanwhile", async () => {
        const id = await submitBankAccount(ctx, USER);
        ctx.ceyPay.addBankAccount.mockImplementationOnce(
          async (_userId: string, a: Parameters<typeof registered>[0]) => {
            await ctx
              .knex('user')
              .where({ id: USER })
              .update({ kyc_status: 'DECLINED' });
            return registered(a);
          },
        );
        await asAdmin(ctx, cookies)
          .post(`/admin/bank-reviews/${id}/approve`)
          .expect(409);
        const row = await account(id);
        expect(row.status).toBe('PENDING_REVIEW');
        expect(row.approving_at).toBeNull();
      });

      // The approve decides: rejecting or removing the account while it is
      // being registered at CeyPay would leave a CeyPay record for an
      // account the member was told is not approved
      it('answers a reject with 409, and the approve completes', async () => {
        const id = await submitBankAccount(ctx, USER);
        let reject = 0;
        ctx.ceyPay.addBankAccount.mockImplementationOnce(
          async (_userId: string, a: Parameters<typeof registered>[0]) => {
            reject = (
              await asAdmin(ctx, cookies).post(
                `/admin/bank-reviews/${id}/reject`,
                { reason: 'Name does not match' },
              )
            ).status;
            return registered(a);
          },
        );
        await asAdmin(ctx, cookies)
          .post(`/admin/bank-reviews/${id}/approve`)
          .expect(200, { id, status: 'VERIFIED' });
        expect(reject).toBe(409);
        expect(ctx.notifyUser).not.toHaveBeenCalledWith(
          USER,
          expect.stringContaining('not approved'),
        );
      });

      it("answers the member's remove with 409, and the approve completes", async () => {
        const id = await submitBankAccount(ctx, USER);
        let remove = 0;
        ctx.ceyPay.addBankAccount.mockImplementationOnce(
          async (_userId: string, a: Parameters<typeof registered>[0]) => {
            remove = (await asUser(ctx, USER).delete(`/bank-accounts/${id}`))
              .status;
            return registered(a);
          },
        );
        await asAdmin(ctx, cookies)
          .post(`/admin/bank-reviews/${id}/approve`)
          .expect(200, { id, status: 'VERIFIED' });
        expect(remove).toBe(409);
        expect((await account(id)).is_active).toBe(true);
      });
    });

    // An approve that outlived its claim must not verify over the approve
    // that took the claim over, even before that one finishes (so this
    // checks the claim, not just status = VERIFIED)
    it("doesn't let an approve whose claim was taken over verify the account", async () => {
      type NewAccount = {
        bankCode: number;
        accountNumber: string;
        accountName: string;
      };
      // supertest closes a server it started itself once a request ends, and
      // that close waits for B, which is still open: listen here instead
      const server = ctx.app.getHttpServer();
      let releaseB!: () => void;
      const bGate = new Promise<void>((r) => (releaseB = r));
      await new Promise<void>((r) => server.listen(0, r));
      try {
        const id = await submitBankAccount(ctx, USER);
        let enteredB!: () => void;
        const bInCeyPay = new Promise<void>((r) => (enteredB = r));
        let approveB!: Promise<request.Response>;

        ctx.ceyPay.addBankAccount
          .mockImplementationOnce(async (_userId: string, a: NewAccount) => {
            // A is slow: its claim expires and B takes it over
            await ctx
              .knex('user_bank_account')
              .where({ id })
              .update({
                approving_at: ctx.knex.raw("now() - interval '1 hour'"),
              });
            approveB = asAdmin(ctx, cookies)
              .post(`/admin/bank-reviews/${id}/approve`)
              .then((res) => res);
            await Promise.race([bInCeyPay, approveB]);
            return { userBankId: randomUUID(), ...a, bankName: 'Bank' };
          })
          .mockImplementationOnce(async (_userId: string, a: NewAccount) => {
            enteredB();
            await bGate;
            return { userBankId: randomUUID(), ...a, bankName: 'Bank' };
          });

        await asAdmin(ctx, cookies)
          .post(`/admin/bank-reviews/${id}/approve`)
          .expect(409);
        const meanwhile = await account(id);
        expect(meanwhile.status).toBe('PENDING_REVIEW');
        expect(meanwhile.approving_at).not.toBeNull(); // B's claim, untouched

        releaseB();
        const b = await approveB;
        expect(b.status).toBe(200);
        expect(b.body).toEqual({ id, status: 'VERIFIED' });
      } finally {
        releaseB(); // so a failed assertion doesn't leave B open
        await new Promise((r) => server.close(r));
      }
    });

    it("rejecting an account with a crashed approve's claim works and clears it", async () => {
      const id = await submitBankAccount(ctx, USER);
      await ctx
        .knex('user_bank_account')
        .where({ id })
        .update({ approving_at: ctx.knex.raw("now() - interval '1 hour'") });
      await asAdmin(ctx, cookies)
        .post(`/admin/bank-reviews/${id}/reject`, {
          reason: 'Blurry statement',
        })
        .expect(200, { id, status: 'REJECTED' });
      expect((await account(id)).approving_at).toBeNull();
    });

    it('reuses the account CeyPay already has instead of adding it again', async () => {
      const id = await submitBankAccount(ctx, USER);
      const existing = randomUUID();
      // An earlier approve registered it, but its answer or commit was lost
      ctx.ceyPay.listBankAccounts.mockResolvedValueOnce([
        {
          userBankId: existing,
          bankCode: 7010,
          bankName: 'Bank',
          accountNumber: '1234567890',
          accountName: 'T. User',
        },
      ]);
      await asAdmin(ctx, cookies)
        .post(`/admin/bank-reviews/${id}/approve`)
        .expect(200, { id, status: 'VERIFIED' });
      expect(ctx.ceyPay.addBankAccount).not.toHaveBeenCalled();
      expect((await account(id)).ceypay_user_bank_id).toBe(existing);
    });

    it('matches what CeyPay lists loosely: bank code as a string, spacing and case', async () => {
      const id = await submitBankAccount(ctx, USER);
      const existing = randomUUID();
      ctx.ceyPay.listBankAccounts.mockResolvedValueOnce([
        {
          userBankId: existing,
          bankCode: '7010' as unknown as number,
          bankName: 'Bank',
          accountNumber: '1234 5678 90',
          accountName: '  t.  user ',
        },
      ]);
      await asAdmin(ctx, cookies)
        .post(`/admin/bank-reviews/${id}/approve`)
        .expect(200, { id, status: 'VERIFIED' });
      expect(ctx.ceyPay.addBankAccount).not.toHaveBeenCalled();
      expect((await account(id)).ceypay_user_bank_id).toBe(existing);
    });

    it("doesn't reuse a CeyPay record for the same number under another name", async () => {
      // e.g. rejected for the name, then resubmitted with it corrected:
      // payouts must go out under the name the reviewer approved
      const id = await submitBankAccount(ctx, USER);
      ctx.ceyPay.listBankAccounts.mockResolvedValueOnce([
        {
          userBankId: randomUUID(),
          bankCode: 7010,
          bankName: 'Bank',
          accountNumber: '1234567890',
          accountName: 'Someone Else',
        },
      ]);
      await asAdmin(ctx, cookies)
        .post(`/admin/bank-reviews/${id}/approve`)
        .expect(200, { id, status: 'VERIFIED' });
      expect(ctx.ceyPay.addBankAccount).toHaveBeenCalledTimes(1);
      expect(ctx.ceyPay.addBankAccount).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ accountName: 'T. User' }),
      );
    });

    it("a crashed approve's claim expires, a fresh one is respected", async () => {
      const id = await submitBankAccount(ctx, USER);
      await ctx
        .knex('user_bank_account')
        .where({ id })
        .update({ approving_at: ctx.knex.raw("now() - interval '1 minute'") });
      await asAdmin(ctx, cookies)
        .post(`/admin/bank-reviews/${id}/approve`)
        .expect(409);

      await ctx
        .knex('user_bank_account')
        .where({ id })
        .update({ approving_at: ctx.knex.raw("now() - interval '1 hour'") });
      await asAdmin(ctx, cookies)
        .post(`/admin/bank-reviews/${id}/approve`)
        .expect(200, { id, status: 'VERIFIED' });
      expect((await account(id)).approving_at).toBeNull();
    });

    it('rejecting needs a reason and lets the user resubmit', async () => {
      const id = await submitBankAccount(ctx, USER);
      await asAdmin(ctx, cookies)
        .post(`/admin/bank-reviews/${id}/reject`, { reason: '  ' })
        .expect(400);
      await asAdmin(ctx, cookies)
        .post(`/admin/bank-reviews/${id}/reject`, {
          reason: 'Name does not match',
        })
        .expect(200, { id, status: 'REJECTED' });

      const row = await account(id);
      expect(row.rejection_reason).toBe('Name does not match');
      expect(ctx.ceyPay.addBankAccount).not.toHaveBeenCalled();
      expect(ctx.notifyUser).toHaveBeenCalledWith(
        USER,
        expect.stringContaining('Name does not match'),
      );

      // the same account can be submitted again
      const again = await submitBankAccount(ctx, USER);
      expect(again).not.toBe(id);
      expect((await account(id)).is_active).toBe(false);
    });
  });

  describe('removing', () => {
    it('soft-deletes the account', async () => {
      const id = await submitBankAccount(ctx, USER);
      await asUser(ctx, USER).delete(`/bank-accounts/${id}`).expect(204);
      expect((await account(id)).is_active).toBe(false);
      await asUser(ctx, USER).get('/bank-accounts').expect(200, []);
    });

    it("can't remove another user's account", async () => {
      const id = await submitBankAccount(ctx, USER);
      await asUser(ctx, OTHER_USER).delete(`/bank-accounts/${id}`).expect(404);
    });
  });
});
