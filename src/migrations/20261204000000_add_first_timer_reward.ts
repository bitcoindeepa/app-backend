import type { Knex } from 'knex';

// First-timer reward (FIRST_TIMER_REWARD_LKR).
// - user.first_timer_reward_payment_id: the payment that claimed the member's
//   reward (null = not claimed). Claimed with a conditional update, so two
//   payments arriving together can't both get it.
// - transaction.bonus_lkr / bonus_satoshis: the reward on the payment that
//   claimed it; bonus_satoshis is priced at the payment's own BTC price and
//   settlement sends satoshis_purchased + bonus_satoshis in one transfer.
// Additive and nullable: the previous release ignores these columns.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user', (table) => {
    table.string('first_timer_reward_payment_id').nullable();
  });

  await knex.schema.alterTable('transaction', (table) => {
    table.decimal('bonus_lkr', 18, 2).nullable();
    table.bigint('bonus_satoshis').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('transaction', (table) => {
    table.dropColumn('bonus_satoshis');
    table.dropColumn('bonus_lkr');
  });

  await knex.schema.alterTable('user', (table) => {
    table.dropColumn('first_timer_reward_payment_id');
  });
}
