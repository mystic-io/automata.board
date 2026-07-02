/**
 * Vivia MVP — L402 / x402 Protocol Service
 *
 * Implements the server-side L402 challenge-response flow:
 *
 * Challenge (402 → client):
 *   WWW-Authenticate: L402 macaroon="<base64>", invoice="<bolt11>"
 *
 * Authorization (client → server):
 *   Authorization: L402 <base64(macaroon)>:<hex(preimage)>
 *
 * This MVP uses HMAC-SHA256 mock macaroons and synthetic invoices.
 * The crypto layer is designed to be swappable for real Aperture/LND
 * integration without changing the handler interface.
 *
 * All cryptographic operations use the Web Crypto API (native to Workers).
 */

import type { L402Challenge, MacaroonPayload } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert an ArrayBuffer to a hex string */
function bufToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Convert a hex string to an ArrayBuffer */
function hexToBuf(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes.buffer;
}

/** Import a raw secret string as an HMAC-SHA256 CryptoKey */
async function importHmacKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

/** HMAC-SHA256 sign a message string and return the hex digest */
async function hmacSign(message: string, key: CryptoKey): Promise<string> {
  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(message)
  );
  return bufToHex(signature);
}

/** SHA-256 hash and return hex */
async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data);
  return bufToHex(hash);
}

// ---------------------------------------------------------------------------
// L402 Challenge Generation
// ---------------------------------------------------------------------------

/**
 * Generates a complete L402 challenge for a gig submission.
 *
 * The mock macaroon structure:
 *   Base64({ identifier, paymentHash, signature })
 *
 * Where:
 *   - identifier = gigId (ties the token to this specific gig)
 *   - paymentHash = SHA256(random 32 bytes) — the hash the client must produce the preimage for
 *   - signature = HMAC-SHA256(identifier + paymentHash, server_secret)
 *
 * The mock invoice is a synthetic BOLT11-style string encoding
 * the amount and payment hash for agent consumption.
 *
 * @param gigId      Unique gig identifier
 * @param bountySats Bounty amount in satoshis (used in invoice)
 * @param secret     Server-side HMAC signing secret
 */
export async function generateChallenge(
  gigId: string,
  bountySats: number,
  secret: string
): Promise<L402Challenge> {
  const key = await importHmacKey(secret);

  // Generate a random preimage and derive the payment hash
  const preimageBytes = new Uint8Array(32);
  crypto.getRandomValues(preimageBytes);
  const paymentHash = await sha256Hex(preimageBytes.buffer);

  // The identifier ties this macaroon to the gig
  const identifier = gigId;

  // Sign the macaroon: HMAC(identifier || paymentHash)
  const signature = await hmacSign(`${identifier}${paymentHash}`, key);

  // Construct the macaroon payload
  const macaroonPayload: MacaroonPayload = {
    identifier,
    paymentHash,
    signature,
  };

  // Base64-encode the macaroon
  const macaroonB64 = btoa(JSON.stringify(macaroonPayload));

  // Construct a synthetic BOLT11-style invoice
  // Format: lnbc<amount>m1p<paymentHash>... (simplified for MVP)
  const invoice = `lnbc${bountySats}m1p${paymentHash.slice(0, 52)}`;

  // Format the WWW-Authenticate header per L402 spec
  const headerValue = `L402 macaroon="${macaroonB64}", invoice="${invoice}"`;

  return {
    macaroon: macaroonB64,
    invoice,
    headerValue,
  };
}

// ---------------------------------------------------------------------------
// L402 Authorization Verification
// ---------------------------------------------------------------------------

export interface VerificationResult {
  valid: boolean;
  gigId?: string;
  error?: string;
}

/**
 * Verifies an L402 Authorization header.
 *
 * Expected format: `L402 <base64(macaroon)>:<hex(preimage)>`
 *
 * Verification steps:
 * 1. Parse the header format
 * 2. Decode the macaroon JSON
 * 3. Verify the HMAC signature (proves the server issued this macaroon)
 * 4. Verify SHA256(preimage) === paymentHash (proves the client paid)
 *
 * @param authHeader The raw Authorization header value
 * @param secret     Server-side HMAC signing secret
 */
export async function verifyAuthorization(
  authHeader: string,
  secret: string
): Promise<VerificationResult> {
  // Step 1: Parse the header
  if (!authHeader.startsWith('L402 ')) {
    return { valid: false, error: 'Authorization scheme must be L402' };
  }

  const credentials = authHeader.slice(5); // Remove "L402 "
  const separatorIndex = credentials.indexOf(':');

  if (separatorIndex === -1) {
    return { valid: false, error: 'Invalid L402 format: expected <macaroon>:<preimage>' };
  }

  const macaroonB64 = credentials.slice(0, separatorIndex);
  const preimageHex = credentials.slice(separatorIndex + 1);

  // Step 2: Decode the macaroon
  let macaroon: MacaroonPayload;
  try {
    const decoded = atob(macaroonB64);
    macaroon = JSON.parse(decoded) as MacaroonPayload;
  } catch {
    return { valid: false, error: 'Malformed macaroon: invalid base64 or JSON' };
  }

  if (!macaroon.identifier || !macaroon.paymentHash || !macaroon.signature) {
    return { valid: false, error: 'Malformed macaroon: missing required fields' };
  }

  // Step 3: Verify the HMAC signature
  const key = await importHmacKey(secret);
  const expectedSig = await hmacSign(
    `${macaroon.identifier}${macaroon.paymentHash}`,
    key
  );

  if (expectedSig !== macaroon.signature) {
    return { valid: false, error: 'Invalid macaroon signature' };
  }

  // Step 4: Verify the preimage → paymentHash relationship
  if (!preimageHex || preimageHex.length !== 64) {
    return { valid: false, error: 'Invalid preimage: expected 64-character hex string' };
  }

  const preimageHash = await sha256Hex(hexToBuf(preimageHex));

  if (preimageHash !== macaroon.paymentHash) {
    return { valid: false, error: 'Payment verification failed: preimage does not match payment hash' };
  }

  return {
    valid: true,
    gigId: macaroon.identifier,
  };
}
