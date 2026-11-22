import crypto from 'node:crypto';
import {
  BadRequestException,
  Controller,
  Headers,
  Inject,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { eq } from 'drizzle-orm';
import { billingEvents, organizations, type HitlDb } from '@hitl/db';
import { DB_TOKEN } from '../db/db.module.js';

interface BillingWebhookEvent {
  id: string;
  type: 'subscription.created' | 'subscription.updated' | 'subscription.canceled';
  data: {
    organization_id: string;
    customer_id?: string;
    subscription_id?: string;
    plan?: 'free' | 'pro' | 'agency' | 'enterprise';
    status?: string;
  };
}

@Controller('v1/billing/webhooks')
export class BillingWebhookController {
  constructor(@Inject(DB_TOKEN) private readonly db: HitlDb) {}

  private verifySignature(rawBody: Buffer, signatureHeader: string | undefined) {
    const secret = process.env.BILLING_WEBHOOK_SECRET;
    if (!secret || !signatureHeader) {
      throw new UnauthorizedException('Missing billing webhook signature');
    }

    const expectedHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const providedHex = signatureHeader.replace(/^sha256=/, '');
    const a = Buffer.from(providedHex, 'utf8');
    const b = Buffer.from(expectedHex, 'utf8');

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid billing webhook signature');
    }
  }

  @Post('mor')
  async handleMorWebhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-billing-signature') signatureHeader: string | undefined,
  ) {
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    this.verifySignature(rawBody, signatureHeader);

    const event = req.body as BillingWebhookEvent;
    if (!event?.id || !event?.type || !event?.data?.organization_id) {
      throw new BadRequestException('Invalid billing webhook payload');
    }

    const [existing] = await this.db
      .select({ id: billingEvents.id })
      .from(billingEvents)
      .where(eq(billingEvents.externalEventId, event.id))
      .limit(1);

    if (existing) {
      return { received: true, deduplicated: true };
    }

    await this.db.transaction(async (tx) => {
      await tx.insert(billingEvents).values({
        provider: 'mor',
        externalEventId: event.id,
        eventType: event.type,
      });

      if (event.type === 'subscription.canceled') {
        await tx
          .update(organizations)
          .set({
            plan: 'free',
            billingStatus: 'canceled',
          })
          .where(eq(organizations.id, event.data.organization_id));
      } else {
        await tx
          .update(organizations)
          .set({
            plan: event.data.plan ?? 'pro',
            billingCustomerId: event.data.customer_id ?? null,
            billingSubscriptionId: event.data.subscription_id ?? null,
            billingStatus: event.data.status ?? 'active',
          })
          .where(eq(organizations.id, event.data.organization_id));
      }
    });

    return { received: true };
  }
}
