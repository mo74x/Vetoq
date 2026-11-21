import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import type { BetterAuthInstance } from './auth.js';

export const BETTER_AUTH_TOKEN = Symbol('BETTER_AUTH');

export interface AuthenticatedSession {
  userId: string;
  email: string;
  name: string;
  activeOrganizationId: string | null;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(BETTER_AUTH_TOKEN) private readonly auth: BetterAuthInstance) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const session = await this.auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (!session?.user) {
      throw new UnauthorizedException('Authentication required');
    }

    req.authSession = {
      userId: session.user.id,
      email: session.user.email,
      name: session.user.name,
      activeOrganizationId: session.session.activeOrganizationId ?? null,
    } satisfies AuthenticatedSession;

    return true;
  }
}
