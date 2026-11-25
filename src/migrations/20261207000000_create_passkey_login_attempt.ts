import type { Knex } from 'knex';

// Passkey logins in progress on the web (no session yet, so the challenge
// can't live on user_session): one row per "Sign in with passkey" prompt,
// deleted when its response is checked (single use), 5 minutes at most.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('passkey_login_attempt', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.text('challenge').notNullable();
    table
      .timestamp('created_at', { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
    table.timestamp('expires_at', { useTz: true }).notNullable();
    table.index(['expires_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('passkey_login_attempt');
}
