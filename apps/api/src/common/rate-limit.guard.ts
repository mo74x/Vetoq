import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_TOKEN } from '../workers/queues.module.js';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(@Inject(REDIS_TOKEN) private readonly redis: Redis) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const ip = String(req.ip ?? req.headers?.['x-forwarded-for'] ?? 'unknown');
    const token = req.params?.token ? String(req.params.token).slice(0, 16) : '';
    const route = String(req.route?.path ?? req.path ?? 'global');
    const bucketKey = `rl:${route}:${ip}:${token}`;

    const count = await this.redis.incr(bucketKey);
    if (count === 1) {
      await this.redis.expire(bucketKey, 60);
    }

    const limit = token ? 30 : 120;
    if (count > limit) {
      throw new HttpException('Rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }

    return true;
  }
}
