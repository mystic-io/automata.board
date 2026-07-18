import { describe, expect, it } from 'vitest';
import { PAYMENT_NETWORK, PAYMENT_NETWORK_NAME } from './config';

describe('payment safety defaults', () => {
  it('targets Base Sepolia, never Base mainnet', () => {
    expect(PAYMENT_NETWORK).toBe('eip155:84532');
    expect(PAYMENT_NETWORK_NAME).toBe('Base Sepolia');
    expect(PAYMENT_NETWORK).not.toBe('eip155:8453');
  });
});
