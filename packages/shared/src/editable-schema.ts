import fastJsonPatch, { type Operation } from 'fast-json-patch';
import type { EditableField, EditableSchemaMap } from './schemas.js';

export interface EditValidationResult {
  valid: boolean;
  errors: string[];
  finalPayload: Record<string, unknown>;
  diff: Operation[];
  changed: boolean;
}

function validateFieldValue(key: string, field: EditableField, value: unknown): string | null {
  switch (field.type) {
    case 'string':
    case 'textarea': {
      if (typeof value !== 'string') {
        return `Field "${key}" must be a string`;
      }
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        return `Field "${key}" exceeds maxLength of ${field.maxLength}`;
      }
      return null;
    }
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
        return `Field "${key}" must be a finite number`;
      }
      if (field.min !== undefined && value < field.min) {
        return `Field "${key}" must be >= ${field.min}`;
      }
      if (field.max !== undefined && value > field.max) {
        return `Field "${key}" must be <= ${field.max}`;
      }
      return null;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        return `Field "${key}" must be a boolean`;
      }
      return null;
    }
    case 'enum': {
      if (typeof value !== 'string' || !field.options.includes(value)) {
        return `Field "${key}" must be one of: ${field.options.join(', ')}`;
      }
      return null;
    }
  }
}

export function applyAndValidateEdits(
  currentPayload: Record<string, unknown>,
  editedFields: Record<string, unknown> | undefined,
  editableSchema: EditableSchemaMap | undefined | null,
): EditValidationResult {
  const finalPayload: Record<string, unknown> = structuredClone(currentPayload);

  if (!editedFields || Object.keys(editedFields).length === 0) {
    return {
      valid: true,
      errors: [],
      finalPayload,
      diff: [],
      changed: false,
    };
  }

  if (!editableSchema) {
    return {
      valid: false,
      errors: ['Editing is not permitted when editable_schema is not defined'],
      finalPayload,
      diff: [],
      changed: false,
    };
  }

  const errors: string[] = [];

  for (const [key, newValue] of Object.entries(editedFields)) {
    const fieldDef = Object.prototype.hasOwnProperty.call(editableSchema, key)
      ? editableSchema[key]
      : undefined;

    if (!fieldDef) {
      errors.push(`Field "${key}" is not declared in editable_schema`);
      continue;
    }
    if (!fieldDef.editable) {
      errors.push(`Field "${key}" is not editable`);
      continue;
    }

    const fieldError = validateFieldValue(key, fieldDef, newValue);
    if (fieldError) {
      errors.push(fieldError);
      continue;
    }

    finalPayload[key] = newValue;
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      finalPayload: structuredClone(currentPayload),
      diff: [],
      changed: false,
    };
  }

  const diff = fastJsonPatch.compare(currentPayload, finalPayload);
  return {
    valid: true,
    errors: [],
    finalPayload,
    diff,
    changed: diff.length > 0,
  };
}
