import { sql } from 'drizzle-orm';
import { check, date, pgPolicy, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { authenticatedRole, authUid, authUsers } from 'drizzle-orm/supabase';

export const timestamptz = () => timestamp({ withTimezone: true, mode: 'string' });

export const day = () => date({ mode: 'string' });

export const oneOf = (name: string, column: AnyPgColumn, values: readonly string[]) =>
  check(name, sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`);

export const ownerId = () =>
  uuid()
    .notNull()
    .references(() => authUsers.id, { onDelete: 'cascade' });

export const ownRows = (table: string, userId: AnyPgColumn) =>
  pgPolicy(`${table}_own_rows`, {
    for: 'all',
    to: authenticatedRole,
    using: sql`${userId} = ${authUid}`,
    withCheck: sql`${userId} = ${authUid}`,
  });

export const readOwnRows = (table: string, userId: AnyPgColumn) =>
  pgPolicy(`${table}_read_own_rows`, {
    for: 'select',
    to: authenticatedRole,
    using: sql`${userId} = ${authUid}`,
  });
