export interface N8nExecuteContext {
  getNodeParameter(name: string, itemIndex: number, fallback?: unknown): unknown;
  getCredentials(type: string): Promise<{ apiUrl: string; apiKey: string }>;
  getInputData(): Array<{ json: Record<string, unknown> }>;
  getExecutionId(): string;
}

export class VetoqApprovalNode {
  description = {
    displayName: 'Vetoq HITL Approval',
    name: 'vetoqApproval',
    group: ['transform'],
    version: 1,
    description: 'Request human-in-the-loop approval with Edit-Before-Execute',
    defaults: { name: 'Vetoq Approval' },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'vetoqApi', required: true }],
    properties: [
      { displayName: 'Action Type', name: 'actionType', type: 'string', default: 'stripe.refund', required: true },
      { displayName: 'Title', name: 'title', type: 'string', default: '', required: true },
      { displayName: 'Summary', name: 'summary', type: 'string', default: '' },
      { displayName: 'Callback URL', name: 'callbackUrl', type: 'string', default: '={{$execution.resumeUrl}}', required: true },
      { displayName: 'Payload (JSON)', name: 'payloadJson', type: 'json', default: '{}' },
      { displayName: 'Editable Schema (JSON)', name: 'editableSchemaJson', type: 'json', default: '{}' },
      { displayName: 'Timeout (Seconds)', name: 'timeoutSeconds', type: 'number', default: 1800 },
    ],
  };

  async execute(this: N8nExecuteContext) {
    const creds = await this.getCredentials('vetoqApi');
    const items = this.getInputData();
    const results: Array<{ json: Record<string, unknown> }> = [];

    for (let i = 0; i < items.length; i++) {
      const actionType = String(this.getNodeParameter('actionType', i));
      const title = String(this.getNodeParameter('title', i));
      const summary = String(this.getNodeParameter('summary', i, ''));
      const callbackUrl = String(this.getNodeParameter('callbackUrl', i));
      const timeoutSeconds = Number(this.getNodeParameter('timeoutSeconds', i, 1800));
      const payloadRaw = this.getNodeParameter('payloadJson', i, '{}');
      const schemaRaw = this.getNodeParameter('editableSchemaJson', i, '{}');

      const payload = typeof payloadRaw === 'string' ? JSON.parse(payloadRaw) : payloadRaw;
      const editableSchema = typeof schemaRaw === 'string' ? JSON.parse(schemaRaw) : schemaRaw;

      const res = await fetch(`${creds.apiUrl.replace(/\/$/, '')}/v1/approvals`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${creds.apiKey}`,
          'Idempotency-Key': `n8n_${this.getExecutionId()}_${i}`,
        },
        body: JSON.stringify({
          action_type: actionType,
          title,
          summary: summary || undefined,
          callback_url: callbackUrl,
          timeout_seconds: timeoutSeconds,
          payload,
          editable_schema: Object.keys(editableSchema as object).length > 0 ? editableSchema : undefined,
        }),
      });

      if (!res.ok) {
        throw new Error(`Vetoq API error (${res.status}): ${await res.text()}`);
      }

      const data = (await res.json()) as Record<string, unknown>;
      results.push({ json: data });
    }

    return [results];
  }
}
