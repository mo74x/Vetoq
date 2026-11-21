import { Global, Module } from '@nestjs/common';
import { createDb, createDbPool, type HitlDb } from '@hitl/db';

export const DB_TOKEN = Symbol('HITL_DB');
export const DB_POOL_TOKEN = Symbol('HITL_DB_POOL');

@Global()
@Module({
  providers: [
    {
      provide: DB_POOL_TOKEN,
      useFactory: () => {
        const url =
          process.env.DATABASE_URL ?? 'postgresql://hitl:hitl_dev_password@localhost:5432/hitl_dev';
        return createDbPool(url);
      },
    },
    {
      provide: DB_TOKEN,
      inject: [DB_POOL_TOKEN],
      useFactory: (pool: ReturnType<typeof createDbPool>): HitlDb => createDb(pool),
    },
  ],
  exports: [DB_TOKEN, DB_POOL_TOKEN],
})
export class DbModule {}
