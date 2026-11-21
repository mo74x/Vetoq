import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Better Auth core tables (usePlural: true + organization plugin)
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  activeOrganizationId: text('active_organization_id'),
});

export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const verifications = pgTable('verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const organizations = pgTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  logo: text('logo'),
  metadata: text('metadata'),
  plan: text('plan').notNull().default('free'),
  brandingConfig: jsonb('branding_config').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const members = pgTable('members', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('member'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const invitations = pgTable('invitations', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role'),
  status: text('status').notNull().default('pending'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  inviterId: text('inviter_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
});

// Domain tables
export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: text('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  defaultApproverEmails: text('default_approver_emails')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  webhookSecretEnc: text('webhook_secret_enc').notNull(),
  webhookSecretPrevEnc: text('webhook_secret_prev_enc'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  keyPrefix: text('key_prefix').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const policies = pgTable(
  'policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    actionType: text('action_type').notNull(),
    priority: integer('priority').notNull().default(100),
    conditions: jsonb('conditions').$type<unknown[]>().notNull().default([]),
    decisionMode: text('decision_mode').notNull(), // auto_approve | require_approval | auto_reject
    requiredApprovals: integer('required_approvals').notNull().default(1),
    timeoutSeconds: integer('timeout_seconds').notNull().default(3600),
    timeoutBehavior: text('timeout_behavior').notNull().default('reject'),
    approverEmails: text('approver_emails')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_policies_project_action')
      .on(table.projectId, table.actionType, table.priority)
      .where(sql`${table.isActive} = true`),
  ],
);

export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    policyId: uuid('policy_id').references(() => policies.id, { onDelete: 'set null' }),
    initialPolicySnapshot: jsonb('initial_policy_snapshot').$type<Record<string, unknown> | null>(),
    effectivePolicySnapshot: jsonb('effective_policy_snapshot').$type<Record<string, unknown> | null>(),
    idempotencyKey: text('idempotency_key'),
    idempotencyRequestHash: text('idempotency_request_hash'),
    actionType: text('action_type').notNull(),
    title: text('title').notNull(),
    summary: text('summary'),
    agentName: text('agent_name'),
    originalPayload: jsonb('original_payload').$type<Record<string, unknown>>().notNull(),
    finalPayload: jsonb('final_payload').$type<Record<string, unknown>>(),
    editableSchema: jsonb('editable_schema').$type<Record<string, unknown> | null>(),
    requiredApprovals: integer('required_approvals').notNull().default(1),
    payloadVersion: integer('payload_version').notNull().default(1),
    editCount: integer('edit_count').notNull().default(0),
    status: text('status').notNull().default('pending'),
    deliveryStatus: text('delivery_status').notNull().default('not_applicable'),
    callbackUrl: text('callback_url').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_requests_project_idempotency')
      .on(table.projectId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    index('idx_requests_project_status').on(table.projectId, table.status, table.createdAt),
    index('idx_requests_pending_expires')
      .on(table.expiresAt)
      .where(sql`${table.status} = 'pending'`),
  ],
);

export const approvalTokens = pgTable('approval_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  approvalRequestId: uuid('approval_request_id')
    .notNull()
    .references(() => approvalRequests.id, { onDelete: 'cascade' }),
  approverEmail: text('approver_email').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const approvalVotes = pgTable(
  'approval_votes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    approvalRequestId: uuid('approval_request_id')
      .notNull()
      .references(() => approvalRequests.id, { onDelete: 'cascade' }),
    approverEmail: text('approver_email').notNull(),
    approverName: text('approver_name').notNull(),
    payloadVersion: integer('payload_version').notNull(),
    decision: text('decision').notNull(), // approve | reject
    editedPayload: jsonb('edited_payload').$type<Record<string, unknown> | null>(),
    note: text('note'),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_votes_active_per_version')
      .on(table.approvalRequestId, table.approverEmail, table.payloadVersion)
      .where(sql`${table.supersededAt} IS NULL`),
  ],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    approvalRequestId: uuid('approval_request_id')
      .notNull()
      .references(() => approvalRequests.id, { onDelete: 'restrict' }),
    eventType: text('event_type').notNull(),
    actorType: text('actor_type').notNull(), // agent | human | system
    actorIdentifier: text('actor_identifier').notNull(),
    diffPayload: jsonb('diff_payload').$type<unknown>(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_audit_logs_request').on(table.approvalRequestId, table.createdAt)],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    approvalRequestId: uuid('approval_request_id')
      .notNull()
      .references(() => approvalRequests.id, { onDelete: 'cascade' }),
    callbackUrl: text('callback_url').notNull(),
    attemptNumber: integer('attempt_number').notNull().default(1),
    httpStatus: integer('http_status'),
    responseBody: text('response_body'),
    status: text('status').notNull().default('pending'), // pending | succeeded | failed
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_webhook_deliveries_pending')
      .on(table.status, table.createdAt)
      .where(sql`${table.status} = 'pending'`),
  ],
);
