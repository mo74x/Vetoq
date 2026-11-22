import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { createApprovalRequestSchema, type CreateApprovalRequest } from '@hitl/shared';
import { ApiKeyGuard, type AuthenticatedProject } from '../common/api-key.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ApprovalsService } from './approvals.service.js';

@Controller('v1/approvals')
@UseGuards(ApiKeyGuard)
export class ApprovalsController {
  constructor(private readonly approvalsService: ApprovalsService) {}

  @Post()
  async create(
    @Req() req: { projectAuth: AuthenticatedProject },
    @Body(new ZodValidationPipe(createApprovalRequestSchema)) body: CreateApprovalRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res() res: Response,
  ) {
    const result = await this.approvalsService.createApproval(
      req.projectAuth.projectId,
      req.projectAuth.orgId,
      req.projectAuth.keyPrefix,
      body,
      idempotencyKey?.slice(0, 128),
    );
    return res.status(result.httpStatus).json(result.data);
  }

  @Get()
  async list(@Req() req: { projectAuth: AuthenticatedProject }) {
    return this.approvalsService.listApprovals(req.projectAuth.projectId);
  }

  @Get(':id')
  async getOne(
    @Req() req: { projectAuth: AuthenticatedProject },
    @Param('id') id: string,
  ) {
    return this.approvalsService.getApprovalById(req.projectAuth.projectId, id);
  }
}
