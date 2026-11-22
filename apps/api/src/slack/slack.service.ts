import { Injectable, Logger } from '@nestjs/common';
import type { EditableSchemaMap } from '@hitl/shared';

export interface SlackApprovalCardInput {
  botToken: string;
  channel: string;
  requestId: string;
  title: string;
  actionType: string;
  summary: string | null;
  payload: Record<string, unknown>;
  hasEditableSchema?: boolean;
}

@Injectable()
export class SlackService {
  private readonly logger = new Logger(SlackService.name);

  async postApprovalCard(input: SlackApprovalCardInput): Promise<void> {
    const elements: Array<Record<string, unknown>> = [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Approve' },
        style: 'primary',
        action_id: 'hitl_approve',
        value: input.requestId,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Reject' },
        style: 'danger',
        action_id: 'hitl_reject',
        value: input.requestId,
      },
    ];

    if (input.hasEditableSchema) {
      elements.splice(1, 0, {
        type: 'button',
        text: { type: 'plain_text', text: 'Edit & Approve' },
        action_id: 'hitl_open_edit',
        value: input.requestId,
      });
    }

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `Approval Required: ${input.title}` },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Action:* \`${input.actionType}\`\n${input.summary ? `${input.summary}\n` : ''}\`\`\`${JSON.stringify(input.payload, null, 2).slice(0, 1500)}\`\`\``,
        },
      },
      {
        type: 'actions',
        elements,
      },
    ];

    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.botToken}`,
      },
      body: JSON.stringify({
        channel: input.channel,
        text: `Approval required: ${input.title}`,
        blocks,
      }),
    });

    if (!res.ok) {
      this.logger.warn(`Slack chat.postMessage failed with HTTP ${res.status}`);
    }
  }

  async openEditModal(params: {
    botToken: string;
    triggerId: string;
    requestId: string;
    title: string;
    currentPayload: Record<string, unknown>;
    editableSchema: EditableSchemaMap;
  }): Promise<void> {
    const blocks = Object.entries(params.editableSchema)
      .filter(([, def]) => def.editable)
      .slice(0, 10)
      .map(([key, def]) => ({
        type: 'input',
        block_id: `field_${key}`,
        label: { type: 'plain_text', text: def.label.slice(0, 2000) },
        element: {
          type: 'plain_text_input',
          action_id: key,
          multiline: def.type === 'textarea',
          initial_value: String(params.currentPayload[key] ?? ''),
        },
      }));

    if (blocks.length === 0) return;

    const res = await fetch('https://slack.com/api/views.open', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.botToken}`,
      },
      body: JSON.stringify({
        trigger_id: params.triggerId,
        view: {
          type: 'modal',
          callback_id: 'hitl_edit_submit',
          private_metadata: params.requestId,
          title: { type: 'plain_text', text: 'Edit & Approve'.slice(0, 24) },
          submit: { type: 'plain_text', text: 'Approve with Edits' },
          close: { type: 'plain_text', text: 'Cancel' },
          blocks,
        },
      }),
    });

    if (!res.ok) {
      this.logger.warn(`Slack views.open failed with HTTP ${res.status}`);
    }
  }
}
