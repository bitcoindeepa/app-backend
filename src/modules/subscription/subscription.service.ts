import { toApiNumber } from '../../common/money';
import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { KnexService } from '../knex/knex.service';
import { PayHereService } from '../payhere/payhere.service';
import { Subscription, SubscriptionDetails } from '../../models/subscription';
import { RedisService } from '../redis/redis.service';
import { CacheKeys } from '../redis/utils/cache-keys.util';
import * as dayjs from 'dayjs';
import { errorMessage } from '../../common/error-message';
import { TelegramLoggerService } from '../telegram-logger/telegram-logger.service';

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(
    private readonly knexService: KnexService,
    private readonly payHereService: PayHereService,
    private readonly redisService: RedisService,
    private readonly telegramLogger: TelegramLoggerService,
  ) {}

  /**
   * The user's active subscription if there is one, else their newest. An
   * active plan must win over a newer inactive row (a declined checkout
   * attempt), or the one-plan check and /cancel would miss the live plan.
   */
  async getCurrentSubscriptionForUser(
    user_id: string,
  ): Promise<Subscription | undefined> {
    return this.knexService
      .knex<Subscription>('subscription')
      .where({ user_id })
      .orderBy('is_active', 'desc')
      .orderBy('created_at', 'desc')
      .first();
  }

  /**
   * Record who a checkout is for before sending the user to PayHere. The
   * webhook resolves the subscription's owner from this row (by the signed
   * order_id), never from the payer-editable custom_1/custom_2.
   */
  async createPayHereOrder(
    order_id: string,
    user_id: string,
    package_id: string,
  ): Promise<void> {
    await this.knexService
      .knex('buy_order')
      .insert({ order_id, user_id, package_id });
  }

  async getCurrentSubscriptionDetailsForUser(
    user_id: string,
  ): Promise<SubscriptionDetails | undefined> {
    const details = await this.redisService.getOrSet(
      CacheKeys.user.subscription(user_id),
      300,
      () => this.loadSubscriptionDetails(user_id),
    );
    return details ?? undefined;
  }

  private async loadSubscriptionDetails(
    user_id: string,
  ): Promise<SubscriptionDetails | undefined> {
    const result = await this.knexService
      .knex('subscription as s')
      .select(
        's.payhere_sub_id',
        's.user_id',
        's.package_id',
        's.is_active',
        's.payment_processor',
        's.created_at',
        's.updated_at',
        'p.name as package_name',
        'p.frequency',
        'p.amount as dca_price',
      )
      .join('package as p', 's.package_id', 'p.id')
      .where('s.user_id', user_id)
      .andWhere('s.is_active', true)
      .orderBy('s.created_at', 'desc')
      .first();

    if (!result) {
      return undefined;
    }

    // Calculate subscription start date (use created_at of subscription)
    const subscriptionStartDate = new Date(result.created_at);

    // Calculate next billing date based on frequency and start date
    let nextBillingDate: Date;
    const now = dayjs();
    const startDate = dayjs(subscriptionStartDate);

    if (result.frequency === 'weekly') {
      // Find the next weekly billing date
      const daysSinceStart = now.diff(startDate, 'day');
      const weeksSinceStart = Math.floor(daysSinceStart / 7);
      nextBillingDate = startDate
        .add((weeksSinceStart + 1) * 7, 'day')
        .toDate();
    } else {
      // Monthly frequency
      const monthsSinceStart = now.diff(startDate, 'month');
      nextBillingDate = startDate.add(monthsSinceStart + 1, 'month').toDate();
    }

    const subscriptionDetails: SubscriptionDetails = {
      payhere_sub_id: result.payhere_sub_id,
      user_id: result.user_id,
      package_id: result.package_id,
      is_active: result.is_active,
      payment_processor: result.payment_processor,
      created_at: result.created_at,
      updated_at: result.updated_at,
      subscription_start_date: subscriptionStartDate,
      dca_price: toApiNumber(result.dca_price), // package.amount, whole LKR
      next_billing_date: nextBillingDate,
      package_name: result.package_name,
      frequency: result.frequency,
    };

    return subscriptionDetails;
  }

  /**
   * Cancel at PayHere, then mark the plan inactive here. No DB transaction is
   * held across PayHere's call (up to 10s plus its OAuth call): it would pin
   * a pool connection for that long, and it can't make the remote cancel
   * atomic anyway. PayHere is where billing stops, so it goes first; if our
   * update then fails, the team is alerted to mark the plan inactive.
   */
  async cancelPayHereSubscription(payhere_sub_id: string): Promise<void> {
    const knex = this.knexService.knex;
    const subscription = await knex('subscription')
      .where('payhere_sub_id', payhere_sub_id)
      .first<{ user_id: string } | undefined>();
    if (!subscription) {
      throw new BadRequestException('Subscription not found');
    }

    let result: Awaited<ReturnType<PayHereService['cancelSubscription']>>;
    try {
      result = await this.payHereService.cancelSubscription(payhere_sub_id);
    } catch (error) {
      this.logger.error(
        `PayHere cancellation of ${payhere_sub_id} failed: ${errorMessage(error)}`,
      );
      throw new BadRequestException('Subscription cancellation failed');
    }
    if (!result || result.status !== 1) {
      throw new BadRequestException(
        `PayHere cancellation failed, status: ${result?.status || 'unknown'}`,
      );
    }

    try {
      await knex('subscription')
        .update({ is_active: false, updated_at: knex.fn.now() })
        .where('payhere_sub_id', payhere_sub_id);
    } catch (error) {
      // PayHere stopped billing, but the app still shows the plan as active
      this.logger.error(
        `Subscription ${payhere_sub_id} was cancelled at PayHere but marking it inactive failed: ${errorMessage(error)}`,
      );
      await this.telegramLogger.logAlert(
        'Subscription',
        'Cancelled at PayHere, but marking it inactive here failed. Set subscription.is_active = false.',
        {
          level: 'stopped',
          title: 'cancelled at PayHere only',
          fields: [
            ['Subscription', payhere_sub_id, 'code'],
            ['User', `#UID${subscription.user_id}`],
            ['Error', errorMessage(error)],
          ],
        },
      );
      throw new BadRequestException('Subscription cancellation failed');
    }

    // Non-critical: the cancellation is recorded
    try {
      await this.invalidateUserSubscriptionCache(subscription.user_id);
    } catch (cacheError) {
      this.logger.warn(
        `Failed to invalidate cache after cancelling ${payhere_sub_id}: ${errorMessage(cacheError)}`,
      );
    }
    this.logger.log(`Subscription ${payhere_sub_id} cancelled`);
  }

  /**
   * Invalidate subscription cache for a user (call when subscription changes)
   */
  async invalidateUserSubscriptionCache(user_id: string): Promise<void> {
    const cacheKey = CacheKeys.user.subscription(user_id);
    await this.redisService.del(cacheKey);
    this.logger.log(`Invalidated subscription cache for user: ${user_id}`);
  }
}
