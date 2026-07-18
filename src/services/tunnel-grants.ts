import type { TunnelGrant, TunnelRole } from '../types';

const TOKEN_BYTES = 32;
const TOKEN_PREFIX = 'atg_v1_';
export const MAX_TUNNEL_GRANT_TOKEN_LENGTH = 128;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    return null;
  }

  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function createTunnelGrant(
  role: TunnelRole,
  agentIdentity: string,
  expiresAt: string
): TunnelGrant {
  const randomBytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(randomBytes);

  return {
    token: `${TOKEN_PREFIX}${bytesToBase64Url(randomBytes)}`,
    role,
    agent_identity: agentIdentity,
    expires_at: expiresAt,
  };
}

export async function hashTunnelGrant(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return bytesToHex(new Uint8Array(digest));
}

export function tunnelGrantHashesEqual(providedHash: string, expectedHash: string): boolean {
  const providedBytes = hexToBytes(providedHash);
  const expectedBytes = hexToBytes(expectedHash);
  if (!providedBytes || !expectedBytes) {
    return false;
  }
  return crypto.subtle.timingSafeEqual(providedBytes, expectedBytes);
}
