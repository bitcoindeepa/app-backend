import type { Knex } from 'knex';

// `updated_at` comes from knex's `timestamps(true, true)`, which only sets a
// default at insert. Nothing kept `transaction.updated_at` (or `user`'s, or
// `buy_order`'s) current, so it always equalled `created_at` (#110). One
// trigger function now sets it whenever a row actually changes.
//
// Not on `sell_order`: its `updated_at` means "last status change or payout
// attempt", and the sell crons time stuck orders from it (`setStatus` and the
// retry claim set it by hand). A trigger would also bump it on bookkeeping
// writes such as `collect_state` (re-synced every 10s while COLLECTING).
// Not on the Better Auth `admin_*` tables either (the library sets its own),
// nor `log` (append-only).
//
// Compatible with the previous release: it keeps writing as before, and a
// hand-written `updated_at` is simply overwritten with the same now().
const TABLES = [
  'transaction',
  'user',
  'subscription',
  'buy_order',
  'package',
  'user_bank_account',
] as const;

const trigger = (table: string) => `${table}_set_updated_at`;

export async function up(knex: Knex): Promise<void> {
  // Only when something changed: a no-op update (same values, e.g. a login
  // re-saving the same Telegram username) leaves it alone. now() is the
  // transaction's start time, like knex.fn.now().
  await knex.raw(`
    CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
    BEGIN
      IF NEW IS DISTINCT FROM OLD THEN
        NEW.updated_at = now();
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  for (const table of TABLES) {
    await knex.raw(
      `CREATE TRIGGER ?? BEFORE UPDATE ON ?? FOR EACH ROW EXECUTE FUNCTION set_updated_at()`,
      [trigger(table), table],
    );
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const table of TABLES) {
    await knex.raw('DROP TRIGGER IF EXISTS ?? ON ??', [trigger(table), table]);
  }
  await knex.raw('DROP FUNCTION IF EXISTS set_updated_at()');
}
