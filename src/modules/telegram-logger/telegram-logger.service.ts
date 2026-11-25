import { Injectable, Logger } from '@nestjs/common';
import type { JwtPayload } from '../auth/auth.service';
import { Package } from '../package/package.service';
import { escapeHtml } from '../../common/escape-html';

export interface TgMessage {
  id: number | null;
  text: string;
}

/**
 * Telegram allows about 20 messages a minute in a group. Routine logs stop a
 * little below that; alerts may use the rest, so a burst of logs can't crowd
 * them out.
 */
const ROUTINE_MESSAGES_PER_MINUTE = 15;
const ALL_MESSAGES_PER_MINUTE = 19;
/** A 429 without retry_after (body or header): pause this long */
const DEFAULT_RETRY_AFTER_SECONDS = 30;
/** Rich alerts refused in a row before alerts go plain for RICH_PAUSE_MS */
const RICH_REFUSALS_BEFORE_PAUSE = 3;
const RICH_PAUSE_MS = 60 * 60_000;

/** "Rs. 25,000" (cents only when there are any) */
export const lkr = (amount: string | number): string =>
  `Rs. ${Number(amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** Routine logs link profiles (t.me): no preview cards in the group */
const NO_LINK_PREVIEW = { is_disabled: true };

/** Alerts held while rate limited, sent when the pause ends */
const MAX_QUEUED_ALERTS = 20;

/** Telegram refuses a sendMessage text longer than this */
export const TELEGRAM_MAX_TEXT_LENGTH = 4096;

/** At most `max` characters (an ellipsis included when cut), never splitting a character */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return '';
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

/**
 * `text` escaped, cut so the text Telegram counts (after it parses the HTML
 * entities) is at most `max` characters. Each kept character is escaped on
 * its own, so a cut never lands inside an entity
 */
function escapeWithin(text: string, max: number): string {
  if (text.length <= max) return escapeHtml(text);
  if (max <= 0) return '';
  let out = '';
  let kept = 0;
  for (const ch of text) {
    if (kept + ch.length > max - 1) break;
    out += escapeHtml(ch);
    kept += ch.length;
  }
  return `${out}…`;
}

/** A log-group call: its result, or whether it failed only because of rate limits */
type CallResult =
  | { ok: true; result: { message_id?: number } | true }
  | { ok: false; limited: boolean; status?: number };

type LogGroupMethod =
  | 'sendMessage'
  | 'sendRichMessage'
  | 'editMessageText'
  | 'setMessageReaction';

/** An alert in both forms: rich (sendRichMessage) and the plain HTML fallback */
interface Alert {
  rich: string;
  plain: string;
  /**
   * Telegram refused the rich form: later attempts (from the queue) send
   * the plain one only, so a refused rich send can't keep using the slot the
   * plain one needs
   */
  richRefused?: boolean;
}

/**
 * How urgent an alert is, shown as its icon: urgent = money at risk, stopped
 * = a human must fix something, config = every payout is affected, waiting =
 * waiting on someone (no fault), reminder = a repeat of open items.
 */
export type AlertLevel =
  | 'urgent'
  | 'stopped'
  | 'config'
  | 'waiting'
  | 'warning'
  | 'reminder';

const ALERT_ICONS: Record<AlertLevel, string> = {
  urgent: '🚨',
  stopped: '🛑',
  config: '🔑',
  waiting: '⏳',
  warning: '⚠️',
  reminder: '🔔',
};

/** One "Label  value" row under an alert; `code` shows the value as code (ids) */
export type AlertField = [label: string, value: string, style?: 'code'];

export interface AlertDetails {
  /** After the source in the heading: "Settlement: waiting for approval" */
  title?: string;
  level?: AlertLevel;
  fields?: AlertField[];
  /** Rich-message HTML in place of `text` (dynamic parts escaped by the caller) */
  richHtml?: string;
}

/**
 * Field values can be unbounded (a bot's error message): each is cut, before
 * escaping so no entity is split, so the fields alone can't push the plain
 * fallback past Telegram's limit
 */
export const MAX_FIELD_VALUE_CHARS = 500;

const fieldValue = ([, value, style]: AlertField) => {
  const shown = escapeHtml(truncateText(value, MAX_FIELD_VALUE_CHARS));
  return style === 'code' ? `<code>${shown}</code>` : shown;
};

/** Plain text as rich paragraphs, one per non-empty line (escaped) */
export function richParagraphs(text: string): string {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('');
}

@Injectable()
export class TelegramLoggerService {
  private readonly logger = new Logger(TelegramLoggerService.name);
  private readonly botToken: string | undefined;
  private readonly logGroupId: string | undefined;
  private readonly logTopicId: string | undefined;
  /** Topic for alerts (needs a human), so they aren't buried in routine logs */
  private readonly alertTopicId: string | undefined;
  /** Telegram's 429 retry_after: nothing goes to the group until then */
  private blockedUntil = 0;
  private droppedWhileLimited = 0;
  private recentSends: number[] = [];
  private warnedNotConfigured = false;
  private queuedAlerts: Alert[] = [];
  /**
   * Plain alerts only until then: for good after a 404 (the Bot API has no
   * sendRichMessage), for an hour after RICH_REFUSALS_BEFORE_PAUSE refusals
   * in a row (rich HTML wrong in a systematic way), so a burst of alerts
   * doesn't spend two calls each against the group's rate limit
   */
  private richOffUntil = 0;
  private richRefusalsInARow = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  /** A drain is sending the queue: no second one may start */
  private draining = false;

  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN;
    this.logGroupId = process.env.LOG_GROUP_ID;
    this.logTopicId = process.env.LOG_TOPIC_ID;
    this.alertTopicId = process.env.ALERT_TOPIC_ID || this.logTopicId;
  }

  /**
   * Who did it, without ever mentioning anyone: no "@", so Telegram makes no
   * mention and notifies nobody (an app username can even be someone else's
   * Telegram name). The Telegram username links to their profile (t.me is a
   * plain link, not a mention); the app username is code text.
   */
  private formatUser(user: JwtPayload): string {
    const tg = user.tgUsername
      ? `<a href="https://t.me/${encodeURIComponent(user.tgUsername)}">${escapeHtml(user.tgUsername)}</a>`
      : // Null when they have no Telegram username, or haven't logged in
        // since tg_username was added: "unknown" is true in both cases
        'unknown';
    const app = user.username
      ? `<code>${escapeHtml(user.username)}</code>`
      : 'not set';
    return `Telegram: ${tg}\nApp user: ${app}\nUser ID: <b>#UID${user.id}</b>`;
  }

  async logNewTransaction(
    payhereId: string,
    amount: string,
    telegramId: string,
    status: string,
    oneTime = false,
  ): Promise<TgMessage | null> {
    const message =
      `💳 <b>${oneTime ? 'New one-time buy' : 'New DCA payment'}</b>${oneTime ? ' #BUY' : ''}\n` +
      `Payment: #TRX${escapeHtml(payhereId)}\n` +
      `Amount: ${lkr(amount)} · ${escapeHtml(status)}\n` +
      `User ID: <b>#UID${telegramId}</b>`;
    return await this.sendMessage(message);
  }

  async logSettlement(
    payhereId: string,
    satoshis: number,
    telegramId: string,
    attemptNumber: number,
  ): Promise<TgMessage | null> {
    const message =
      `⚡ <b>Settlement attempt ${attemptNumber}</b>\n` +
      `Payment: #TRX${escapeHtml(payhereId)}\n` +
      `Sats: ${Number(satoshis).toLocaleString('en-US')}\n` +
      `User ID: <b>#UID${telegramId}</b>`;
    return await this.sendMessage(message);
  }

  async logSubscriptionCreated(
    subscriptionId: string,
    userId: string,
    _package: Package,
  ): Promise<void> {
    const message =
      `📅 <b>New subscription</b>\n` +
      `Plan: ${escapeHtml(_package.name)} · ${lkr(_package.amount)}\n` +
      `Subscription: #SUB${escapeHtml(subscriptionId)}\n` +
      `User ID: <b>#UID${userId}</b>`;
    await this.sendMessage(message, true);
  }

  /**
   * Something that needs a human to look at it (fraud signal, manual fix).
   * `text` is plain text: it is escaped, since an error message containing
   * `<` or `&` would make Telegram reject the whole (HTML) alert. It goes out
   * as a rich message: "<icon> <source>: <title>" heading, `richHtml` or
   * `text` as paragraphs, then `fields` as a compact table. If Telegram
   * refuses that, as a plain HTML message with the same content as lines.
   * Keep `text` to a sentence or two: the fields carry the ids and amounts.
   */
  async logAlert(
    source: string,
    text: string,
    details: AlertDetails = {},
  ): Promise<void> {
    const icon = ALERT_ICONS[details.level ?? 'warning'];
    const heading = escapeHtml(
      details.title ? `${source}: ${details.title}` : source,
    );
    const fields = details.fields ?? [];
    const table = fields.length
      ? `<table compact>${fields
          .map(
            (f) =>
              `<tr><td><b>${escapeHtml(f[0])}</b></td><td>${fieldValue(f)}</td></tr>`,
          )
          .join('')}</table>`
      : '';
    // The plain fallback must fit Telegram's text limit whatever `text` holds
    // (error messages, stored reasons): `text` gets what the rest leaves
    const plainHead = `${icon} <b>${heading}</b>`;
    const plainFields = fields.map(
      (f) => `${escapeHtml(f[0])}: ${fieldValue(f)}`,
    );
    const textBudget =
      TELEGRAM_MAX_TEXT_LENGTH -
      [plainHead, ...plainFields].join('\n').length -
      1;
    const message: Alert = {
      rich: `<h3>${icon} ${heading}</h3>${details.richHtml ?? richParagraphs(text)}${table}`,
      plain: [plainHead, escapeWithin(text, textBudget), ...plainFields].join(
        '\n',
      ),
    };
    if (!this.isConfigured()) {
      this.logger.error(`ALERT (${source}): ${text}`);
      return;
    }
    // Earlier alerts are still waiting: go behind them, so alerts arrive in
    // order and new ones don't use up the slots the queue is waiting for
    const outcome =
      this.queuedAlerts.length > 0
        ? { ok: false, limited: true }
        : await this.sendAlert(message);
    if (outcome.ok) return;
    // Never lose an alert silently: it's always in the app log, and when only
    // rate limits stopped it, it's sent once the pause ends
    if (outcome.limited && this.queueAlert(message)) {
      this.logger.error(
        `ALERT (${source}) delayed by Telegram rate limits, queued: ${text}`,
      );
    } else {
      this.logger.error(`ALERT (${source}) not sent to Telegram: ${text}`);
    }
  }

  /**
   * Send one alert to ALERT_TOPIC_ID (LOG_TOPIC_ID when unset): rich first,
   * the plain HTML message when Telegram refuses the rich one for any reason
   * but a rate limit (that is retried as is, from the queue).
   */
  private async sendAlert(alert: Alert): Promise<CallResult> {
    if (Date.now() >= this.richOffUntil && !alert.richRefused) {
      const rich = await this.callLogGroup(
        'sendRichMessage',
        {
          rich_message: { html: alert.rich },
          message_thread_id: this.alertTopicId,
        },
        true,
      );
      if (rich.ok) this.richRefusalsInARow = 0;
      if (rich.ok || rich.limited) return rich;
      alert.richRefused = true;
      if (rich.status === 404) {
        this.richOffUntil = Infinity;
        this.logger.warn(
          'Telegram has no sendRichMessage here: sending plain alerts from now on',
        );
      } else if (++this.richRefusalsInARow >= RICH_REFUSALS_BEFORE_PAUSE) {
        this.richRefusalsInARow = 0;
        this.richOffUntil = Date.now() + RICH_PAUSE_MS;
        this.logger.warn(
          `Telegram refused ${RICH_REFUSALS_BEFORE_PAUSE} rich alerts in a row: plain alerts for the next hour`,
        );
      }
    }
    return this.callLogGroup(
      'sendMessage',
      {
        text: alert.plain,
        parse_mode: 'HTML',
        message_thread_id: this.alertTopicId,
      },
      true,
    );
  }

  /** Hold an alert until the rate limit pause ends. False when the queue is full. */
  private queueAlert(message: Alert): boolean {
    if (this.queuedAlerts.length >= MAX_QUEUED_ALERTS) return false;
    this.queuedAlerts.push(message);
    this.scheduleAlertFlush();
    return true;
  }

  private scheduleAlertFlush(): void {
    // A running drain schedules the next one itself when it ends
    if (this.flushTimer || this.draining || this.queuedAlerts.length === 0) {
      return;
    }
    // After the 429 pause, or after the per-minute window frees a slot
    const delay = Math.max(this.blockedUntil - Date.now(), 0) + 1_000;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushAlerts();
    }, delay);
    this.flushTimer.unref?.();
  }

  /** Send queued alerts in order; stop (and reschedule) at the first limit. */
  async flushAlerts(): Promise<void> {
    // Two drains at once would both send the queue's head
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queuedAlerts.length > 0) {
        const outcome = await this.sendAlert(this.queuedAlerts[0]);
        // Limited: the head stays queued and is retried by the next drain
        if (!outcome.ok && outcome.limited) break;
        // Sent, or failed for another reason (already in the app log): next
        this.queuedAlerts.shift();
      }
    } finally {
      this.draining = false;
    }
    this.scheduleAlertFlush();
  }

  /**
   * Direct message to a user through the bot (best effort; never throws).
   * `text` is HTML - escape user-supplied parts with escapeHtml().
   */
  async notifyUser(telegramId: string, text: string): Promise<boolean> {
    if (!this.botToken) return false;
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: telegramId,
            text,
            parse_mode: 'HTML',
          }),
        },
      );
      if (!response.ok) {
        this.logger.warn(
          `Telegram message to user ${telegramId} failed (HTTP ${response.status})`,
        );
      }
      return response.ok;
    } catch (error) {
      this.logger.warn(
        `Telegram message to user ${telegramId} failed: ${(error as Error).message}`,
      );
      return false;
    }
  }

  async logGenericAction(
    action: string,
    user: JwtPayload,
  ): Promise<TgMessage | null> {
    const message = `<b>${escapeHtml(action)}</b>\n` + this.formatUser(user);
    return await this.sendMessage(message);
  }

  /**
   * Post "Action: <action>" to the log group, run `fn`, and react to the
   * message once `fn` succeeds. `fn` gets the message so it can append to it.
   */
  async trackAction<T>(
    action: string,
    user: JwtPayload,
    fn: (message: TgMessage | null) => Promise<T>,
  ): Promise<T> {
    const message = await this.logGenericAction(action, user);
    const result = await fn(message);
    await this.setMessageReaction(message);
    return result;
  }

  async appendToMessage(
    message: TgMessage | null,
    appendText: string,
  ): Promise<void> {
    // No message: the original send was skipped or failed - nothing to edit
    if (!this.isConfigured() || !message?.id) return;
    const text = `${message.text}\n${appendText}`;
    const outcome = await this.callLogGroup('editMessageText', {
      message_id: message.id.toString(),
      text,
      parse_mode: 'HTML',
      link_preview_options: NO_LINK_PREVIEW,
    });
    if (outcome.ok) message.text = text;
  }

  async setMessageReaction(message: TgMessage | null): Promise<void> {
    // No message: the original send was skipped or failed - nothing to react to
    if (!this.isConfigured() || !message?.id) return;
    await this.callLogGroup('setMessageReaction', {
      message_id: message.id.toString(),
      reaction: [{ type: 'emoji', emoji: '👍' }],
      is_big: true,
    });
  }

  /** Bot token and log group set; warns once (not on every log) when not. */
  private isConfigured(): boolean {
    if (this.botToken && this.logGroupId) return true;
    if (!this.warnedNotConfigured) {
      this.warnedNotConfigured = true;
      this.logger.warn(
        'TELEGRAM_BOT_TOKEN or LOG_GROUP_ID not configured: Telegram ops logs are off',
      );
    }
    return false;
  }

  /**
   * Whether the group may get another call now. Honors Telegram's 429
   * retry_after, and keeps under its ~20/min group limit itself. Every call
   * counts (edits and reactions too: Telegram limits those per group as
   * well); only alerts may go past the routine cap, so a burst of logs and
   * 👍 reactions can't use up the alerts' headroom or earn a 429 that would
   * pause them. Skipped messages are counted and reported in one line when
   * sending resumes.
   */
  private mayPost(method: LogGroupMethod, priority: boolean): boolean {
    const now = Date.now();
    this.recentSends = this.recentSends.filter((t) => now - t < 60_000);
    const cap =
      priority && (method === 'sendMessage' || method === 'sendRichMessage')
        ? ALL_MESSAGES_PER_MINUTE
        : ROUTINE_MESSAGES_PER_MINUTE;
    if (now < this.blockedUntil || this.recentSends.length >= cap) {
      if (method === 'sendMessage' || method === 'sendRichMessage') {
        this.droppedWhileLimited++;
      }
      return false;
    }
    if (this.droppedWhileLimited > 0) {
      this.logger.warn(
        `Telegram log group: ${this.droppedWhileLimited} message(s) skipped while rate limited`,
      );
      this.droppedWhileLimited = 0;
    }
    this.recentSends.push(now);
    return true;
  }

  /**
   * One call to the Bot API in the log group (LOG_TOPIC_ID added unless the
   * payload names its own topic). Returns the response's `result`, or null on
   * any failure - logged in one line, never the whole response/error object.
   */
  private async callLogGroup(
    method: LogGroupMethod,
    payload: Record<string, unknown>,
    priority = false,
  ): Promise<CallResult> {
    if (!this.mayPost(method, priority)) return { ok: false, limited: true };
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.botToken}/${method}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.logGroupId,
            ...(this.logTopicId && { message_thread_id: this.logTopicId }),
            ...payload,
          }),
        },
      );
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        result?: { message_id?: number } | true;
        description?: string;
        parameters?: { retry_after?: number };
      };
      if (response.ok && data.ok !== false) {
        return { ok: true, result: data.result ?? true };
      }

      if (response.status === 429) {
        // retry_after from the body, else the Retry-After header, else a default
        const header = Number(response.headers?.get?.('retry-after'));
        const retryAfter =
          data.parameters?.retry_after ??
          (header > 0 ? header : DEFAULT_RETRY_AFTER_SECONDS);
        this.pauseFor(retryAfter);
        return { ok: false, limited: true };
      }
      this.logger.error(
        `Telegram ${method} failed (HTTP ${response.status}): ${data.description ?? 'no description'}`,
      );
      return { ok: false, limited: false, status: response.status };
    } catch (error) {
      this.logger.error(
        `Telegram ${method} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { ok: false, limited: false };
    }
  }

  /**
   * Pause the group until `seconds` from now. Only ever extends the pause:
   * concurrent 429s (calls already in flight) can't shorten it, and only an
   * extension is logged.
   */
  private pauseFor(seconds: number): void {
    const until = Date.now() + seconds * 1000;
    if (until <= this.blockedUntil) return;
    this.blockedUntil = until;
    this.logger.warn(
      `Telegram rate limited the log group: pausing Telegram logs for ${seconds}s`,
    );
  }

  private async sendMessage(
    text: string,
    addReaction: boolean = false,
    priority: boolean = false,
  ): Promise<TgMessage | null> {
    if (!this.isConfigured()) return null;
    const outcome = await this.callLogGroup(
      'sendMessage',
      { text, parse_mode: 'HTML', link_preview_options: NO_LINK_PREVIEW },
      priority,
    );
    if (!outcome.ok) return null;
    const { result } = outcome;
    const tgMessage: TgMessage = {
      text,
      id: (result !== true && result.message_id) || null,
    };
    if (addReaction && tgMessage.id) {
      await this.setMessageReaction(tgMessage);
    }
    return tgMessage;
  }
}
