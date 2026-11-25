import type { Knex } from 'knex';

// settlement_failure gets the bot's refusals that need different handling
// than REJECTED: APPROVAL_DELIVERY and BUSY are retried on a slower schedule,
// OVER_LIMIT and NO_WALLET stop at once for a human. Only the CHECK changes,
// and it accepts everything the previous release writes.
const OLD = ['LOW_BALANCE', 'REJECTED', 'AUTH', 'UNKNOWN', 'APPROVAL_REJECTED'];
const NEW = [...OLD, 'APPROVAL_DELIVERY', 'BUSY', 'OVER_LIMIT', 'NO_WALLET'];

// NOT VALID: no scan of `transaction` under the exclusive lock while the old
// release still serves. Every existing row passed the old, narrower CHECK, so
// it passes this one; new and updated rows are checked as usual.
const check = (values: string[]) => `
  ALTER TABLE "transaction"
    ADD CONSTRAINT transaction_settlement_failure_check CHECK (
      settlement_failure IS NULL OR settlement_failure IN
        (${values.map((v) => `'${v}'`).join(', ')})
    ) NOT VALID
`;

export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    'ALTER TABLE "transaction" DROP CONSTRAINT transaction_settlement_failure_check',
  );
  await knex.raw(check(NEW));
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(
    'ALTER TABLE "transaction" DROP CONSTRAINT transaction_settlement_failure_check',
  );
  // The older release only knows these as a refusal
  await knex('transaction')
    .whereIn(
      'settlement_failure',
      NEW.filter((v) => !OLD.includes(v)),
    )
    .update({ settlement_failure: 'REJECTED' });
  await knex.raw(check(OLD));
}
