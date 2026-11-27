import type { Knex } from 'knex';

// buy_order.replaces_payhere_sub_id: a plan switch. Set when a member with an
// active plan opens a checkout for another package; the webhook then retires
// that plan when the new one's first payment succeeds (and only then, so an
// abandoned checkout leaves the old plan running). Nullable, no default:
// Postgres adds it without rewriting the table, and the previous release
// ignores it.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('buy_order', (table) => {
    table
      .string('replaces_payhere_sub_id')
      .nullable()
      .references('payhere_sub_id')
      .inTable('subscription')
      .onDelete('RESTRICT');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('buy_order', (table) => {
    table.dropColumn('replaces_payhere_sub_id');
  });
}
