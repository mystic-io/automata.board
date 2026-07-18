import type { AppContext } from '../types';
import { errorResponse } from '../utils/validation';

export async function handleTunnelConnect(c: AppContext): Promise<Response> {
  const gigId = c.req.param('id');
  if (!gigId) {
    return errorResponse('Gig ID is required', 400);
  }

  try {
    const headers = new Headers(c.req.raw.headers);
    headers.set('X-Correlation-ID', c.get('correlationId'));
    return c.env.TUNNEL.getByName(gigId).fetch(new Request(c.req.raw, { headers }));
  } catch (error) {
    console.error('Tunnel connection error:', error);
    return errorResponse('Failed to connect to tunnel', 500);
  }
}
