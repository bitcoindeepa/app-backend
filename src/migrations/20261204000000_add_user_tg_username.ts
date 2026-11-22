import type { Knex } from 'knex';

// The member's Telegram username, as Telegram last sent it at login (Mini App
// initData `user.username`, web login `preferred_username`); null when they
// have none. Not the Bitcoin Deepa @username (`username`). Only for showing
// and linking (https://t.me/<name>) in ops logs: Telegram usernames change
// hands, so it is not unique and never identifies anyone - user.id does.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user', (table) => {
    table.string('tg_username', 32).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user', (table) => {
    table.dropColumn('tg_username');
  });
}
