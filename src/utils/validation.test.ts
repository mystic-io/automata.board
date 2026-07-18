import { describe, expect, it } from 'vitest';
import { validateClaimGigPayload, validateCreateGigPayload } from './validation';

const validCreatePayload = {
  message_id: 'message-1',
  sender: '0xbuyer',
  type: 'TaskDelegation',
  payload: {
    title: 'Extract a dataset',
    description: 'Collect the requested fields from the target.',
    task_type: 'data_extraction',
    task_params: { target: 'https://example.com/data' },
    bounty_sats: 50,
    ttl_minutes: 60,
  },
};

describe('validateCreateGigPayload', () => {
  it('accepts a complete task delegation envelope', () => {
    expect(validateCreateGigPayload(validCreatePayload)).toEqual({
      data: validCreatePayload,
      errors: [],
    });
  });

  it('rejects unsupported task types and oversized TTLs', () => {
    const result = validateCreateGigPayload({
      ...validCreatePayload,
      payload: { ...validCreatePayload.payload, task_type: 'shell', ttl_minutes: 121 },
    });

    expect(result.data).toBeNull();
    expect(result.errors.map(({ field }) => field)).toEqual([
      'payload.task_type',
      'payload.ttl_minutes',
    ]);
  });

  it('rejects arrays as task parameters', () => {
    const result = validateCreateGigPayload({
      ...validCreatePayload,
      payload: { ...validCreatePayload.payload, task_params: [] },
    });

    expect(result.data).toBeNull();
    expect(result.errors).toContainEqual({
      field: 'payload.task_params',
      message: 'Must be a JSON object',
    });
  });

  it('rejects an identity with ambiguous surrounding whitespace', () => {
    const result = validateCreateGigPayload({ ...validCreatePayload, sender: ' 0xbuyer' });

    expect(result.data).toBeNull();
    expect(result.errors.map(({ field }) => field)).toContain('sender');
  });
});

describe('validateClaimGigPayload', () => {
  it('accepts a valid task claim envelope', () => {
    const payload = {
      message_id: 'message-2',
      sender: '0xworker',
      type: 'TaskClaim',
      payload: { gig_id: 'gig-1' },
    };

    expect(validateClaimGigPayload(payload)).toEqual({ data: payload, errors: [] });
  });

  it('rejects an empty gig identifier', () => {
    const result = validateClaimGigPayload({
      message_id: 'message-2',
      sender: '0xworker',
      type: 'TaskClaim',
      payload: { gig_id: '  ' },
    });

    expect(result.data).toBeNull();
    expect(result.errors).toContainEqual({
      field: 'payload.gig_id',
      message: 'Must be a non-empty string',
    });
  });
});
