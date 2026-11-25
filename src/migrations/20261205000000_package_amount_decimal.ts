// Deferred to the release after 2.0.2 (#76): this migration is now a no-op.
//
// Turning package.amount into decimal(18, 2) makes pg return it as a string,
// and only 2.0.2's conversions (#74: PackageService.fromRow, toApiNumber on
// /subscription/current.dca_price, /transaction/list and /transaction/latest
// package_amount) turn it back into a number for the apps. Production
// migrates while the previous release is still serving, and a rollback
// starts an older build against the new schema, so the column can only
// change once every running build and rollback target has those
// conversions, i.e. in the release after 2.0.2. A later migration does the
// change then.
//
// The file stays (as a no-op) because development databases already ran it:
// knex refuses to start when an applied migration's file is missing. On
// those the column is already decimal, which 2.0.2 handles; the later
// migration is a no-op there.
export async function up(): Promise<void> {}

export async function down(): Promise<void> {}
