import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { submitDecisionRequestSchema, type SubmitDecisionRequest } from '@hitl/shared';
import { RateLimitGuard } from '../common/rate-limit.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ReviewService } from './review.service.js';

@Controller('v1/review')
@UseGuards(RateLimitGuard)
export class ReviewController {
  constructor(private readonly reviewService: ReviewService) {}

  @Get('resolve-domain')
  async resolveDomain(@Query('host') host: string) {
    return this.reviewService.resolveCustomDomain(host ?? '');
  }

  @Get(':token')
  async getContext(@Param('token') token: string) {
    return this.reviewService.getReviewContext(token);
  }

  @Post(':token/otp')
  async sendOtp(@Param('token') token: string) {
    return this.reviewService.sendOtp(token);
  }

  @Post(':token/viewed')
  async recordViewed(@Param('token') token: string, @Req() req: Request) {
    return this.reviewService.recordViewed(token, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Post(':token/decide')
  async decide(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(submitDecisionRequestSchema)) body: SubmitDecisionRequest,
  ) {
    return this.reviewService.submitDecision(token, body);
  }
}
