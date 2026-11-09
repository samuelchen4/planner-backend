import { sql } from 'drizzle-orm';
import { check, date, pgPolicy, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { authenticatedRole, authUid, authUsers } from 'drizzle-orm/supabase';

// Column and policy helpers shared by the models. Dates and times are kept as strings in the app
// (ISO 8601), the same as SQLite stores them on the phone.

/** A moment in time with its UTC offset, e.g. '2026-11-09T09:30:00-08:00'. */
export const timestamptz = () => timestamp({ withTimezone: true, mode: 'string' });

/** A calendar day, e.g. '2026-11-09'. */
export const day = () => date({ mode: 'string' });

/** A CHECK constraint keeping a text column to a fixed set of values (the model's enum). */
export const oneOf = (name: string, column: AnyPgColumn, values: readonly string[]) =>
  check(name, sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`);

/** The owning user (Supabase auth.users.id); their rows go when the account is deleted. */
export const ownerId = () =>
  uuid()
    .notNull()
    .references(() => authUsers.id, { onDelete: 'cascade' });

/**
 * Row Level Security: a signed-in user may only read and change their own rows. (The API and the
 * calendar worker connect as a privileged role and enforce ownership themselves.)
 */
export const ownRows = (table: string, userId: AnyPgColumn) =>
  pgPolicy(`${table}_own_rows`, {
    for: 'all',
    to: authenticatedRole,
    using: sql`${userId} = ${authUid}`,
    withCheck: sql`${userId} = ${authUid}`,
  });

/** Row Level Security for server-written tables: users may only read their own rows. */
export const readOwnRows = (table: string, userId: AnyPgColumn) =>
  pgPolicy(`${table}_read_own_rows`, {
    for: 'select',
    to: authenticatedRole,
    using: sql`${userId} = ${authUid}`,
  });
