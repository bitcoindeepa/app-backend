import type { Knex } from 'knex';

// An admin's approve claims the account (approving_at = now) in a short
// transaction, calls CeyPay with no transaction or lock held, then records
// VERIFIED only if its claim still holds (#97). Before, the account and the
// member's `user` row stayed locked FOR UPDATE across the CeyPay calls, which
// blocked every insert referencing the member for up to ~20s.
//
// Nullable and unused by the previous release, so it is compatible with it.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_bank_account', (table) => {
    table.timestamp('approving_at', { useTz: true }).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_bank_account', (table) => {
    table.dropColumn('approving_at');
  });
}
