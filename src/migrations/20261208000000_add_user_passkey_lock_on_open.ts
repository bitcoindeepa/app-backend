import type { Knex } from 'knex';

// user.passkey_lock_on_open: whether the web app asks for the member's
// passkey each time it opens. On by default, and set on again when the
// member adds their first passkey; they can turn it off in settings.
// Sends and sale payments need a passkey approval either way.
// A constant default: Postgres adds the column without rewriting the table.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user', (table) => {
    table.boolean('passkey_lock_on_open').notNullable().defaultTo(true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user', (table) => {
    table.dropColumn('passkey_lock_on_open');
  });
}
