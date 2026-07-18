import type { AppContext } from '../types';
import { listActiveGigs } from '../services/gigs';
import { errorResponse, jsonResponse } from '../utils/validation';

export async function handleDiscoverGigs(c: AppContext): Promise<Response> {
  try {
    const gigs = await listActiveGigs(c.env);
    return jsonResponse({ count: gigs.length, gigs });
  } catch (error) {
    console.error('D1 discovery query error:', error);
    return errorResponse('Failed to fetch active gigs', 500);
  }
}
