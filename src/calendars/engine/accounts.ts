import { and, eq, sql } from 'drizzle-orm';

import { db } from '../../db/client';
import {
  calendarAccounts,
  calendarCredentials,
  calendars,
  calendarSyncState,
  type CalendarAccount,
  type CalendarProviderId,
} from '../../db/schema';
import { decryptCredentials, encryptCredentials } from '../credentials';
import { NeedsReconnect, type CalendarProvider, type ConnectedAccount } from '../provider';
import { providerFor } from '../registry';

/** Store a newly connected (or reconnected) account and its login. Returns the account id. */
export async function connectAccount(
  userId: string,
  provider: CalendarProviderId,
  account: ConnectedAccount,
): Promise<string> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(calendarAccounts)
      .values({
        user_id: userId,
        provider,
        provider_account_id: account.providerAccountId,
        email: account.email,
        scopes: account.scopes,
      })
      .onConflictDoUpdate({
        target: [
          calendarAccounts.user_id,
          calendarAccounts.provider,
          calendarAccounts.provider_account_id,
        ],
        set: {
          email: account.email,
          scopes: account.scopes,
          status: 'active',
          updated_at: sql`now()`,
        },
      })
      .returning({ id: calendarAccounts.id });
    const ciphertext = encryptCredentials(account.credentials);
    await tx
      .insert(calendarCredentials)
      .values({ account_id: row!.id, ciphertext })
      .onConflictDoUpdate({
        target: calendarCredentials.account_id,
        set: { ciphertext, updated_at: sql`now()` },
      });
    return row!.id;
  });
}

async function markNeedsReconnect(accountId: string) {
  await db
    .update(calendarAccounts)
    .set({ status: 'needs_reconnect', updated_at: sql`now()` })
    .where(eq(calendarAccounts.id, accountId));
}

/**
 * Run provider calls for an active account with a fresh access token. Returns null (and does
 * nothing) when the account is gone or needs reconnecting; a revoked or expired login marks it
 * `needs_reconnect` so the app can show "Reconnect".
 */
export async function withAccess<T>(
  accountId: string,
  work: (token: string, provider: CalendarProvider, account: CalendarAccount) => Promise<T>,
): Promise<T | null> {
  const [row] = await db
    .select({ account: calendarAccounts, ciphertext: calendarCredentials.ciphertext })
    .from(calendarAccounts)
    .innerJoin(calendarCredentials, eq(calendarCredentials.account_id, calendarAccounts.id))
    .where(eq(calendarAccounts.id, accountId));
  if (!row || row.account.status !== 'active') return null;

  const provider = providerFor(row.account.provider);
  try {
    const { token, credentials } = await provider.accessToken(decryptCredentials(row.ciphertext));
    if (credentials) {
      await db
        .update(calendarCredentials)
        .set({ ciphertext: encryptCredentials(credentials), updated_at: sql`now()` })
        .where(eq(calendarCredentials.account_id, accountId));
    }
    return await work(token, provider, row.account);
  } catch (e) {
    if (!(e instanceof NeedsReconnect)) throw e;
    await markNeedsReconnect(accountId);
    return null;
  }
}

/** Stop live updates, revoke the login (best effort) and delete the account with everything in it. */
export async function disconnectAccount(accountId: string) {
  const [row] = await db
    .select({ account: calendarAccounts, ciphertext: calendarCredentials.ciphertext })
    .from(calendarAccounts)
    .leftJoin(calendarCredentials, eq(calendarCredentials.account_id, calendarAccounts.id))
    .where(eq(calendarAccounts.id, accountId));
  if (!row) return;
  const provider = providerFor(row.account.provider);

  if (row.ciphertext && row.account.status === 'active') {
    await withAccess(accountId, async (token) => {
      const subscriptions = await db
        .select({ state: calendarSyncState })
        .from(calendarSyncState)
        .innerJoin(calendars, eq(calendars.id, calendarSyncState.calendar_id))
        .where(and(eq(calendars.account_id, accountId)));
      for (const { state } of subscriptions) {
        if (!state.subscription_id || !state.subscription_secret || !state.subscription_expires_at)
          continue;
        await provider
          .unsubscribe(token, {
            id: state.subscription_id,
            resourceId: state.subscription_resource_id,
            secret: state.subscription_secret,
            expiresAt: state.subscription_expires_at,
          })
          .catch((e) => console.warn('[calendars] unsubscribe failed (ignored)', e));
      }
    }).catch((e) => console.warn('[calendars] cleanup before disconnect failed (ignored)', e));
  }
  if (row.ciphertext) {
    await provider
      .revoke(decryptCredentials(row.ciphertext))
      .catch((e) => console.warn('[calendars] revoke failed (ignored)', e));
  }
  // Cascades to credentials, calendars, their sync state and events.
  await db.delete(calendarAccounts).where(eq(calendarAccounts.id, accountId));
}

/** Planner account deletion: disconnect every calendar account the user has. */
export async function disconnectAll(userId: string) {
  const accounts = await db
    .select({ id: calendarAccounts.id })
    .from(calendarAccounts)
    .where(eq(calendarAccounts.user_id, userId));
  for (const { id } of accounts) await disconnectAccount(id);
}
