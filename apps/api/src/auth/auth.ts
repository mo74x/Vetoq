import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import * as schema from '@hitl/db';
import type { HitlDb } from '@hitl/db';

export function createBetterAuth(db: HitlDb) {
  const webUrl = process.env.WEB_URL ?? process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema,
      usePlural: true,
    }),
    secret: process.env.BETTER_AUTH_SECRET ?? 'change_me_to_a_long_random_secret_at_least_32_chars',
    baseURL: process.env.BETTER_AUTH_URL ?? webUrl,
    trustedOrigins: [webUrl],
    advanced: {
      trustedProxyHeaders: true,
    },
    emailAndPassword: {
      enabled: true,
    },
    plugins: [organization()],
  });
}

export type BetterAuthInstance = ReturnType<typeof createBetterAuth>;
