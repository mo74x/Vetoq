import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export * from './schema.js';

export type HitlDb = NodePgDatabase<typeof schema>;

export function createDbPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}

export function createDb(pool: pg.Pool): HitlDb {
  return drizzle(pool, { schema });
}
