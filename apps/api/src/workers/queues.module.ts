import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { Redis } from 'ioredis';

export const REDIS_TOKEN = Symbol('HITL_REDIS');

export const QUEUE_TIMEOUTS = 'hitl-timeouts';
export const QUEUE_WEBHOOKS = 'hitl-webhooks';
export const QUEUE_EMAILS = 'hitl-emails';
export const QUEUE_RECONCILIATION = 'hitl-reconciliation';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: () => ({
        connection: {
          url: process.env.REDIS_URL ?? 'redis://localhost:6379',
          maxRetriesPerRequest: null,
        },
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
      useFactory: () => new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379'),
    },
  ],
  exports: [BullModule, REDIS_TOKEN],
})
export class QueuesModule {}
