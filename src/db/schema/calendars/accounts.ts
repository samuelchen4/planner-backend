import { sql } from 'drizzle-orm';
import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { oneOf, ownerId, readOwnRows, timestamptz } from '../columns';
import { ACCOUNT_STATUSES, CALENDAR_PROVIDERS } from './constants';

/**
 * A connected calendar account (a Google account, a Microsoft account, …). A user can connect
 * several, from any mix of providers. Written only by the calendar module; devices get the
 * display columns (see powersync/sync-rules.yaml). The login itself is in calendar_credentials.
 */
export const calendarAccounts = pgTable(
  'calendar_accounts',
  {
    id: uuid().primaryKey().defaultRandom(),
    user_id: ownerId(),
    provider: text({ enum: CALENDAR_PROVIDERS }).notNull(),
    /** The account's id at the provider (Google `sub`, Microsoft object id). */
    provider_account_id: text().notNull(),
    email: text().notNull(),
    /** Scopes the user granted; features check these before running. */
    scopes: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text({ enum: ACCOUNT_STATUSES }).notNull().default('active'),
    created_at: timestamptz().notNull().defaultNow(),
    updated_at: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('calendar_accounts_identity_idx').on(t.user_id, t.provider, t.provider_account_id),
    index('calendar_accounts_user_idx').on(t.user_id),
    readOwnRows('calendar_accounts', t.user_id),
    oneOf('calendar_accounts_provider_check', t.provider, CALENDAR_PROVIDERS),
    oneOf('calendar_accounts_status_check', t.status, ACCOUNT_STATUSES),
  ],
);

/**
 * An account's login (refresh token etc.), encrypted by the calendar module (AES-256-GCM, see
 * src/calendars/credentials.ts). Server-only: RLS on with no policies, not in the PowerSync
 * publication, so no client can ever read it.
 */
export const calendarCredentials = pgTable('calendar_credentials', {
  account_id: uuid()
    .primaryKey()
    .references(() => calendarAccounts.id, { onDelete: 'cascade' }),
  /** Encrypted JSON, in whatever shape the provider's adapter needs. */
  ciphertext: text().notNull(),
  updated_at: timestamptz().notNull().defaultNow(),
}).enableRLS();

export type CalendarAccount = typeof calendarAccounts.$inferSelect;
