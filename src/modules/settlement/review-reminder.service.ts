import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Knex } from 'knex';
import { KnexService } from '../knex/knex.service';
import { RedisService } from '../redis/redis.service';
import { TelegramLoggerService } from '../telegram-logger/telegram-logger.service';
import { errorMessage } from '../../common/error-message';
import { escapeHtml } from '../../common/escape-html';
import { SellStatus } from '../sell/sell.constants';
import { MAX_SETTLEMENT_ATTEMPTS } from '../transaction/transaction.service';
import { describeFailure } from './settlement-failure';

/** How often the reminder goes out while anything is waiting */
export const REMINDER_INTERVAL_HOURS = 3;
/** Newer items were alerted moments ago; give a human time to act first */
const MIN_AGE_MINUTES = 30;
/**
 * Buys drop out of the reminder after this long. Nothing marks a held buy
 * that was refunded in PayHere, or a forged payment that will never settle,
 * as dealt with, so they would be repeated forever. Sales stay until their
 * status is changed: the member's sats are with us.
 */
const BUY_MAX_AGE_DAYS = 7;
/** Rows listed per group (Telegram messages are capped at 4096 characters) */
const LISTED_PER_GROUP = 8;

interface Group {
  /** Short name, the rich message's section heading */
  heading: string;
  /** What to do about it */
  hint: string;
  total: number;
  /** One per listed row, for the plain text */
  lines: string[];
  /** The same rows as table cells, for the rich message */
  columns: string[];
  rows: string[][];
}

const cell = (tag: 'th' | 'td', value: string) =>
  `<${tag}>${escapeHtml(value)}</${tag}>`;

/** The reminder as a rich message: per group a heading, the hint and a table */
function richReminder(total: number, groups: Group[]): string {
  return [
    `<p><b>${total} item(s)</b> still waiting for a human.</p>`,
    ...groups.map((group) => {
      const more = group.total - group.rows.length;
      return [
        `<h4>${escapeHtml(group.heading)} (${group.total})</h4>`,
        `<p>${escapeHtml(group.hint)}</p>`,
        '<table bordered striped compact>',
        `<tr>${group.columns.map((c) => cell('th', c)).join('')}</tr>`,
        ...group.rows.map(
          (row) => `<tr>${row.map((v) => cell('td', v)).join('')}</tr>`,
        ),
        '</table>',
        ...(more > 0 ? [`<p>and ${more} more</p>`] : []),
      ].join('');
    }),
    `<footer>Repeated every ${REMINDER_INTERVAL_HOURS}h while anything waits</footer>`,
  ].join('');
}

const num = (value: string | number) => Number(value).toLocaleString('en-US');

/**
 * Everything that waits for a human is alerted exactly once, when it happens,
 * and Telegram alerts are best effort: if that one message is lost (Telegram
 * down), or the process died before sending it, nothing else would ever
 * mention the order again. This repeats what is still open:
 *
 *   - sales in NEEDS_REVIEW
 *   - held one-time buys
 *   - payments whose settlement stopped (attempts used up, e.g. a crash
 *     during the last attempt or an unknown transfer outcome)
 */
@Injectable()
export class ReviewReminderService {
  private readonly logger = new Logger(ReviewReminderService.name);

  constructor(
    private readonly knexService: KnexService,
    private readonly redisService: RedisService,
    private readonly telegramLogger: TelegramLoggerService,
  ) {}

  @Cron(`0 */${REMINDER_INTERVAL_HOURS} * * *`)
  async remind(): Promise<void> {
    try {
      const groups = (
        await Promise.all([
          this.salesInReview(),
          this.heldBuys(),
          this.stoppedSettlements(),
        ])
      ).filter((group) => group.total > 0);
      if (groups.length === 0) return;

      // One reminder per interval, whichever instance gets there first
      const first = await this.redisService.setIfAbsent(
        'dca:alert:review-reminder',
        REMINDER_INTERVAL_HOURS * 3600 - 300,
      );
      if (!first) return;

      const total = groups.reduce((sum, group) => sum + group.total, 0);
      const text = [
        `${total} item(s) still waiting for a human (repeated every ${REMINDER_INTERVAL_HOURS}h):`,
        ...groups.map((group) => {
          const more = group.total - group.lines.length;
          return [
            `\n${group.heading} (${group.hint}) (${group.total}):`,
            ...group.lines.map((line) => `- ${line}`),
            ...(more > 0 ? [`- and ${more} more`] : []),
          ].join('\n');
        }),
      ].join('\n');
      await this.telegramLogger.logAlert(
        'Waiting for review',
        text,
        richReminder(total, groups),
      );
    } catch (error) {
      this.logger.error(`Review reminder failed: ${errorMessage(error)}`);
    }
  }

  private async salesInReview(): Promise<Group> {
    const query = () =>
      this.knexService
        .knex('sell_order')
        .where('status', SellStatus.NEEDS_REVIEW)
        .whereRaw(
          `updated_at <= now() - interval '${MIN_AGE_MINUTES} minutes'`,
        );
    const rows = await query()
      .select<
        {
          id: string;
          user_id: string;
          sats: string;
          amount_lkr: string;
          failure_reason: string | null;
        }[]
      >('id', 'user_id', 'sats', 'amount_lkr', 'failure_reason')
      .orderBy('updated_at')
      .limit(LISTED_PER_GROUP);
    return {
      heading: 'Sales in NEEDS_REVIEW',
      hint: 'sats collected, check before refunding',
      total: await this.count(query()),
      lines: rows.map(
        (row) =>
          `${row.id}: ${num(row.sats)} sats for ${row.amount_lkr} LKR, #UID${row.user_id}` +
          (row.failure_reason ? ` - ${row.failure_reason}` : ''),
      ),
      columns: ['Order', 'Sats', 'LKR', 'User', 'Reason'],
      rows: rows.map((row) => [
        row.id,
        num(row.sats),
        row.amount_lkr,
        `#UID${row.user_id}`,
        row.failure_reason ?? '',
      ]),
    };
  }

  private async heldBuys(): Promise<Group> {
    const query = () =>
      this.knexService
        .knex('transaction')
        .where({ status: 'SUCCESS', settled: false })
        .whereNotNull('hold_reason')
        .whereRaw(`created_at <= now() - interval '${MIN_AGE_MINUTES} minutes'`)
        .whereRaw(`created_at >= now() - interval '${BUY_MAX_AGE_DAYS} days'`);
    const rows = await query()
      .select<
        {
          payhere_pay_id: string;
          user_id: string | null;
          gross_amount: string | null;
          hold_reason: string;
        }[]
      >('payhere_pay_id', 'user_id', 'gross_amount', 'hold_reason')
      .orderBy('created_at')
      .limit(LISTED_PER_GROUP);
    return {
      heading: 'Held one-time buys',
      hint: 'POST /transaction/release-hold/<id>, or refund in PayHere',
      total: await this.count(query()),
      lines: rows.map(
        (row) =>
          `${row.payhere_pay_id}: ${row.gross_amount ?? '?'} LKR, #UID${row.user_id ?? '?'} - ${row.hold_reason}`,
      ),
      columns: ['Payment', 'LKR', 'User', 'Reason'],
      rows: rows.map((row) => [
        row.payhere_pay_id,
        row.gross_amount ?? '?',
        `#UID${row.user_id ?? '?'}`,
        row.hold_reason,
      ]),
    };
  }

  private async stoppedSettlements(): Promise<Group> {
    const query = () =>
      this.knexService
        .knex('transaction')
        .where({ status: 'SUCCESS', settled: false })
        .whereNull('hold_reason')
        // Awaiting approval in the bot: followed by pollAwaitingApprovals
        .whereNull('bot_send_id')
        .whereNotNull('satoshis_purchased')
        .where('retry_count', '>=', MAX_SETTLEMENT_ATTEMPTS)
        .whereRaw(
          `last_retry_at <= now() - interval '${MIN_AGE_MINUTES} minutes'`,
        )
        .whereRaw(
          `last_retry_at >= now() - interval '${BUY_MAX_AGE_DAYS} days'`,
        );
    const rows = await query()
      .select<
        {
          payhere_pay_id: string;
          user_id: string | null;
          satoshis_purchased: string;
          settlement_failure: string | null;
        }[]
      >('payhere_pay_id', 'user_id', 'satoshis_purchased', 'settlement_failure')
      .orderBy('last_retry_at')
      .limit(LISTED_PER_GROUP);
    return {
      heading: `Paid but not settled after ${MAX_SETTLEMENT_ATTEMPTS} attempts`,
      hint: 'check PayHere and BitcoinDeepa before POST /transaction/reset-retry-count/<id>',
      total: await this.count(query()),
      lines: rows.map(
        (row) =>
          `${row.payhere_pay_id}: ${num(row.satoshis_purchased)} sats, #UID${row.user_id ?? '?'}` +
          (row.settlement_failure
            ? ` - ${describeFailure(row.settlement_failure)}`
            : ''),
      ),
      columns: ['Payment', 'Sats', 'User', 'Reason'],
      rows: rows.map((row) => [
        row.payhere_pay_id,
        num(row.satoshis_purchased),
        `#UID${row.user_id ?? '?'}`,
        row.settlement_failure ? describeFailure(row.settlement_failure) : '',
      ]),
    };
  }

  private async count(query: Knex.QueryBuilder): Promise<number> {
    const [row] = await query.count<{ total: string }[]>('* as total');
    return Number(row?.total ?? 0);
  }
}
