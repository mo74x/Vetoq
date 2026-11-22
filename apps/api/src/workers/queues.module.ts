import { Global, Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { Redis } from 'ioredis';

export const REDIS_TOKEN = Symbol('HITL_REDIS');

export const QUEUE_TIMEOUTS = 'hitl-timeouts';
export const QUEUE_WEBHOOKS = 'hitl-webhooks';
export const QUEUE_EMAILS = 'hitl-emails';
export const QUEUE_RECONCILIATION = 'hitl-reconciliation';

function getRedisConnectionOptions() {
  const rawUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  const parsed = new URL(rawUrl);
  const host = parsed.hostname === 'localhost' ? '127.0.0.1' : parsed.hostname;
  return {
    host,
    port: parsed.port ? Number(parsed.port) : 6379,
    password: parsed.password || undefined,
    maxRetriesPerRequest: null as null,
  };
}

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: () => ({
        connection: getRedisConnectionOptions(),
      }),
    }),
    BullModule.registerQueue(
      { name: QUEUE_TIMEOUTS },
      { name: QUEUE_WEBHOOKS },
      { name: QUEUE_EMAILS },
      { name: QUEUE_RECONCILIATION },
    ),
  ],
  providers: [
    {
      provide: REDIS_TOKEN,
      useFactory: () => new Redis(getRedisConnectionOptions()),
    },
  ],
  exports: [BullModule, REDIS_TOKEN],
})
export class QueuesModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_TOKEN) private readonly redis: Redis) {}

  onModuleDestroy() {
    this.redis.disconnect();
  }
}
