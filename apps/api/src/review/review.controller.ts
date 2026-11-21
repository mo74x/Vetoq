import { Body, Controller, Get, Param, Post, Req, UsePipes } from '@nestjs/common';
import type { Request } from 'express';
import { submitDecisionRequestSchema, type SubmitDecisionRequest } from '@hitl/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ReviewService } from './review.service.js';

@Controller('v1/review')
export class ReviewController {
  constructor(private readonly reviewService: ReviewService) {}

  @Get(':token')
  async getContext(@Param('token') token: string) {
    return this.reviewService.getReviewContext(token);
  }

  @Post(':token/viewed')
  async recordViewed(@Param('token') token: string, @Req() req: Request) {
    return this.reviewService.recordViewed(token, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Post(':token/decide')
  @UsePipes(new ZodValidationPipe(submitDecisionRequestSchema))
  async decide(@Param('token') token: string, @Body() body: SubmitDecisionRequest) {
    return this.reviewService.submitDecision(token, body);
  }
}
