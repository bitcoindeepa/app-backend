import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { errorMessage } from '../../common/error-message';

/** Lark answers within a second or two; don't hold a Didit webhook longer than this */
const LARK_TIMEOUT_MS = 5000;

export interface LarkKycInReviewData {
  /** Who is being verified, e.g. "Bitcoin Deepa member" */
  subject: string;
  /** Label/value lines shown on the card, in order; empty values are dropped */
  fields: Array<{ label: string; value: string | null | undefined }>;
  /** Didit console link for the reviewer; the button is left out when there is none */
  diditUrl: string | null;
}

/**
 * Lark group notifications through a custom bot webhook (the same kind of
 * card CeyPay posts). Posts to the group the bot was added to
 * (`LARK_KYC_WEBHOOK_URL`). Best effort: an unconfigured or failing Lark is
 * logged, never thrown, so it can't break the webhook that triggered it.
 */
@Injectable()
export class LarkService {
  private readonly logger = new Logger(LarkService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Lark's custom bot signature: HMAC-SHA256 keyed with "<timestamp>\n<secret>"
   * over an empty message, base64 encoded. The timestamp is in seconds.
   */
  sign(timestamp: number, secret: string): string {
    return crypto
      .createHmac('sha256', `${timestamp}\n${secret}`)
      .update('')
      .digest('base64');
  }

  /**
   * Tell the KYC group that a Didit session needs a manual decision.
   * @returns Whether Lark accepted the message
   */
  async sendKycInReview(data: LarkKycInReviewData): Promise<boolean> {
    const lines = data.fields
      .filter((field) => field.value)
      .map((field) => `${field.label}: ${field.value}`);

    const elements: Record<string, unknown>[] = [
      { tag: 'div', text: { tag: 'plain_text', content: lines.join('\n') } },
    ];
    if (data.diditUrl) {
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Open in Didit' },
            type: 'primary',
            url: data.diditUrl,
          },
        ],
      });
    }

    return this.send({
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true },
        header: {
          template: 'orange',
          title: {
            tag: 'plain_text',
            content: `🔍 KYC in review: ${data.subject}`,
          },
        },
        elements,
      },
    });
  }

  private async send(message: Record<string, unknown>): Promise<boolean> {
    const url = this.configService.get<string>('LARK_KYC_WEBHOOK_URL');
    if (!url) {
      this.logger.warn(
        'LARK_KYC_WEBHOOK_URL not configured, skipping Lark notification',
      );
      return false;
    }

    const body: Record<string, unknown> = { ...message };
    const secret = this.configService.get<string>('LARK_KYC_WEBHOOK_SECRET');
    if (secret) {
      const timestamp = Math.floor(Date.now() / 1000);
      body.timestamp = String(timestamp);
      body.sign = this.sign(timestamp, secret);
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(LARK_TIMEOUT_MS),
      });
      // Lark reports most failures (bad signature, rate limit) as HTTP 200 with a non-zero code
      const result = (await response.json().catch(() => null)) as {
        code?: number;
        msg?: string;
      } | null;
      if (!response.ok || !result || result.code !== 0) {
        this.logger.error(
          `Lark rejected the notification: HTTP ${response.status}, code ${result?.code}, ${result?.msg}`,
        );
        return false;
      }
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to send Lark notification: ${errorMessage(error)}`,
      );
      return false;
    }
  }
}
