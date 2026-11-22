import { z } from 'zod';

export const MAX_APPROVAL_BODY_BYTES = 64 * 1024;
export const MAX_EDIT_ROUNDS = 3;

export const policyOperatorSchema = z.enum([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'contains',
]);

export const policyConditionSchema = z.object({
  field: z.string().min(1).max(200),
  op: policyOperatorSchema,
  value: z.unknown(),
});

export type PolicyCondition = z.infer<typeof policyConditionSchema>;

export const decisionModeSchema = z.enum(['auto_approve', 'require_approval', 'auto_reject']);
export type DecisionMode = z.infer<typeof decisionModeSchema>;

export const policyRuleSchema = z.object({
  id: z.string().uuid(),
  action_type: z.string().min(1),
  priority: z.number().int(),
  conditions: z.array(policyConditionSchema),
  decision_mode: decisionModeSchema,
  required_approvals: z.number().int().min(1).default(1),
  timeout_seconds: z.number().int().min(60).max(604800).default(3600),
  timeout_behavior: z.literal('reject').default('reject'),
  require_otp: z.boolean().default(false),
  approver_emails: z.array(z.string().email()).default([]),
  is_active: z.boolean().default(true),
});

export type PolicyRule = z.infer<typeof policyRuleSchema>;

export const editableFieldSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('string'),
    label: z.string().min(1).max(120),
    editable: z.boolean(),
    maxLength: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('textarea'),
    label: z.string().min(1).max(120),
    editable: z.boolean(),
    maxLength: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('number'),
    label: z.string().min(1).max(120),
    editable: z.boolean(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.object({
    type: z.literal('boolean'),
    label: z.string().min(1).max(120),
    editable: z.boolean(),
  }),
  z.object({
    type: z.literal('enum'),
    label: z.string().min(1).max(120),
    editable: z.boolean(),
    options: z.array(z.string()).min(1),
  }),
]);

export type EditableField = z.infer<typeof editableFieldSchema>;

export const editableSchemaMapSchema = z.record(z.string().min(1), editableFieldSchema);
export type EditableSchemaMap = z.infer<typeof editableSchemaMapSchema>;

export const createApprovalRequestSchema = z.object({
  action_type: z.string().min(1).max(128),
  title: z.string().min(1).max(256),
  summary: z.string().max(2000).optional(),
  agent_name: z.string().max(128).optional(),
  callback_url: z.string().url().max(2048),
  timeout_seconds: z.number().int().min(60).max(604800).optional(),
  payload: z.record(z.string(), z.unknown()),
  editable_schema: editableSchemaMapSchema.optional(),
});

export type CreateApprovalRequest = z.infer<typeof createApprovalRequestSchema>;

export const submitDecisionRequestSchema = z
  .object({
    action_nonce: z.string().min(1),
    payload_version: z.number().int().min(1),
    decision: z.enum(['approve', 'reject']),
    approver_name: z.string().min(1).max(120).optional(),
    otp_code: z.string().regex(/^\d{6}$/).optional(),
    edited_fields: z.record(z.string(), z.unknown()).optional(),
    note: z.string().max(2000).optional(),
  })
  .superRefine((val, ctx) => {
    if (
      val.decision === 'reject' &&
      val.edited_fields &&
      Object.keys(val.edited_fields).length > 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'edited_fields must be empty when decision is reject',
        path: ['edited_fields'],
      });
    }
  });

export type SubmitDecisionRequest = z.infer<typeof submitDecisionRequestSchema>;

export const webhookEventSchema = z.enum([
  'approval.approved',
  'approval.edited_and_approved',
  'approval.rejected',
  'approval.timed_out',
]);

export type WebhookEvent = z.infer<typeof webhookEventSchema>;

export const webhookCallbackPayloadSchema = z.object({
  event: webhookEventSchema,
  request_id: z.string().uuid(),
  action_type: z.string(),
  status: z.enum(['approved', 'edited_and_approved', 'rejected', 'timed_out']),
  decided_by: z
    .object({
      name: z.string(),
      email: z.string().email(),
    })
    .optional(),
  decision_note: z.string().optional(),
  original_payload: z.record(z.string(), z.unknown()),
  final_payload: z.record(z.string(), z.unknown()),
  decided_at: z.string(),
});

export type WebhookCallbackPayload = z.infer<typeof webhookCallbackPayloadSchema>;
