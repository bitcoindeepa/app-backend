import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

export class PayHereLinkDto {
  // 'loose' = any 8-4-4-4-12 hex id (what Postgres' uuid type accepts).
  // Production package ids are 00000000-0000-0000-0000-00000000000N, which the
  // default/'all' modes reject because they lack an RFC version digit.
  @IsUUID('loose')
  package_id: string;

  /**
   * Switch from the member's active plan to this package. The active plan
   * keeps running until the new plan's first payment succeeds, then the
   * webhook retires it. Without it, a member with an active plan gets 409.
   */
  @IsOptional()
  @IsBoolean()
  switch?: boolean;
}
