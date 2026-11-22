import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { HitlDb } from '@hitl/db';
import { DB_TOKEN } from '../db/db.module.js';
import { REDIS_TOKEN } from '../workers/queues.module.js';

@Controller('healthz')
export class HealthController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: HitlDb,
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
  ) {}

  @Get()
  async check() {
    try {
      await this.db.execute(sql`SELECT 1`);
      const pong = await this.redis.ping();
      if (pong !== 'PONG') {
        throw new Error('Redis ping failed');
      }
      return { status: 'ok', postgres: 'up', redis: 'up' };
    } catch (err) {
      throw new ServiceUnavailableException(
        err instanceof Error ? err.message : 'Service unhealthy',
      );
    }
  }
}
