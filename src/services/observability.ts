import type { GigLifecycleState } from '../types';

export type LogLevel = 'info' | 'warn' | 'error';

export interface TelemetryFields {
  correlation_id: string;
  gig_id?: string;
  lifecycle_state?: GigLifecycleState;
  lifecycle_version?: number;
  from_state?: GigLifecycleState;
  to_state?: GigLifecycleState;
  reason?: string;
  role?: 'buyer' | 'worker';
  outcome?: string;
  status?: number;
  method?: string;
  path?: string;
  duration_ms?: number;
  error_name?: string;
  [key: string]: unknown;
}

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function resolveCorrelationId(headerValue: string | null): string {
  const value = headerValue?.trim();
  return value && CORRELATION_ID_PATTERN.test(value) ? value : crypto.randomUUID();
}

export function logEvent(level: LogLevel, event: string, fields: TelemetryFields): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  const serialized = JSON.stringify(entry);
  if (level === 'error') {
    console.error(serialized);
  } else if (level === 'warn') {
    console.warn(serialized);
  } else {
    console.log(serialized);
  }
}

export function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
