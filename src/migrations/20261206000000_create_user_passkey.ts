import type { Knex } from 'knex';

// Passkeys (WebAuthn) that lock the user app on the web/PWA.
//
// user_passkey: one row per registered passkey. Only the public key is
// stored; credential_id is the authenticator's id (base64url, unique).
// counter is the signature counter (0 for most synced passkeys).
//
// user_session.unlocked_at: when this session last unlocked with a passkey.
// A web session of a member with a passkey is locked until then (and again
// once it's too old). webauthn_challenge*: the one pending WebAuthn
// challenge of the session, single use, short-lived; for an approval
// (a send or a sale payment) webauthn_challenge_action names the exact
// action it approves.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('user_passkey', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table
      .string('user_id')
      .notNullable()
      .references('id')
      .inTable('user')
      .onDelete('CASCADE');
    table.text('credential_id').notNullable().unique();
    table.binary('public_key').notNullable();
    table.bigInteger('counter').notNullable().defaultTo(0);
    table.specificType('transports', 'text[]').nullable();
    table.string('device_type', 32).nullable();
    table.boolean('backed_up').notNullable().defaultTo(false);
    table.string('name', 64).notNullable();
    table
      .timestamp('created_at', { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
    table.timestamp('last_used_at', { useTz: true }).nullable();
    table.index(['user_id']);
  });

  await knex.schema.alterTable('user_session', (table) => {
    table.timestamp('unlocked_at', { useTz: true }).nullable();
    table.text('webauthn_challenge').nullable();
    table.string('webauthn_challenge_kind', 16).nullable();
    table.text('webauthn_challenge_action').nullable();
    table
      .timestamp('webauthn_challenge_expires_at', { useTz: true })
      .nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_session', (table) => {
    table.dropColumn('unlocked_at');
    table.dropColumn('webauthn_challenge');
    table.dropColumn('webauthn_challenge_kind');
    table.dropColumn('webauthn_challenge_action');
    table.dropColumn('webauthn_challenge_expires_at');
  });
  await knex.schema.dropTableIfExists('user_passkey');
}
