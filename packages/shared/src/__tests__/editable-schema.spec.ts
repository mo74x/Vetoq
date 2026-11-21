import { describe, expect, it } from 'vitest';
import { applyAndValidateEdits } from '../editable-schema.js';
import type { EditableSchemaMap } from '../schemas.js';

const schema: EditableSchemaMap = {
  refund_amount_usd: {
    type: 'number',
    label: 'Refund Amount',
    editable: true,
    min: 0,
    max: 500,
  },
  order_id: {
    type: 'string',
    label: 'Order ID',
    editable: false,
  },
};

describe('applyAndValidateEdits', () => {
  it('applies valid edits and generates RFC 6902 diff', () => {
    const res = applyAndValidateEdits(
      { order_id: 'ord_1', refund_amount_usd: 240 },
      { refund_amount_usd: 120 },
      schema,
    );
    expect(res.valid).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.finalPayload).toEqual({ order_id: 'ord_1', refund_amount_usd: 120 });
    expect(res.diff).toEqual([{ op: 'replace', path: '/refund_amount_usd', value: 120 }]);
  });

  it('rejects edits to locked fields', () => {
    const res = applyAndValidateEdits(
      { order_id: 'ord_1', refund_amount_usd: 240 },
      { order_id: 'ord_999' },
      schema,
    );
    expect(res.valid).toBe(false);
    expect(res.errors[0]).toContain('not editable');
  });

  it('rejects edits exceeding numeric bounds', () => {
    const res = applyAndValidateEdits(
      { order_id: 'ord_1', refund_amount_usd: 240 },
      { refund_amount_usd: 999 },
      schema,
    );
    expect(res.valid).toBe(false);
    expect(res.errors[0]).toContain('<= 500');
  });
});
