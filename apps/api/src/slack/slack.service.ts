import { Injectable, Logger } from '@nestjs/common';

export interface SlackApprovalCardInput {
  botToken: string;
  channel: string;
  requestId: string;
  title: string;
  actionType: string;
  summary: string | null;
  payload: Record<string, unknown>;
}

@Injectable()
export class SlackService {
  private readonly logger = new Logger(SlackService.name);

  async postApprovalCard(input: SlackApprovalCardInput): Promise<void> {
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
        elements: [
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
        ],
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
}
