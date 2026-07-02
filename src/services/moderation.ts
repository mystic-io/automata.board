/**
 * Vivia MVP — AI Moderation Service
 *
 * Two-layer content filtering pipeline:
 * 1. OpenAI Moderation API (omni-moderation-latest) — catches explicit/harmful content
 * 2. Prompt Injection Heuristic — deterministic regex scanner for common injection patterns
 *
 * The second layer replaces Claude Haiku for the MVP to keep dependencies minimal.
 * It can be swapped for a real LLM call by implementing the same interface.
 */

import type { ModerationResult } from '../types';

// ---------------------------------------------------------------------------
// Prompt Injection Heuristic Patterns
// ---------------------------------------------------------------------------

/**
 * Common prompt injection / jailbreak patterns observed in the wild.
 * These are checked against the concatenation of all text fields.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+(all\s+)?prior\s+instructions/i,
  /disregard\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /forget\s+(all\s+)?(previous|prior|your)\s+instructions/i,
  /you\s+are\s+now\s+(a|an|the)\s+/i,
  /\bsystem\s*:\s*/i,
  /\bassistant\s*:\s*/i,
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /<\|endoftext\|>/i,
  /\[\[SYSTEM\]\]/i,
  /\bDAN\s+mode/i,
  /do\s+anything\s+now/i,
  /jailbreak/i,
  /bypass\s+(all\s+)?(filters?|restrictions?|safety|guardrails?)/i,
  /act\s+as\s+if\s+you\s+have\s+no\s+(restrictions?|limitations?)/i,
  /pretend\s+(you\s+are|to\s+be)\s+/i,
  /reveal\s+(your|the)\s+(system\s+)?prompt/i,
  /\bexec\s*\(/i,
  /\beval\s*\(/i,
  /\bos\.\s*(system|popen|exec)/i,
  /\bsubprocess\./i,
  /\b__import__\s*\(/i,
];

/**
 * Scans text for common prompt injection patterns.
 * Returns the first matching pattern description, or null if clean.
 */
function detectInjection(text: string): string | null {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      return `Prompt injection detected: matches pattern ${pattern.source}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// OpenAI Moderation API
// ---------------------------------------------------------------------------

interface OpenAIModerationCategory {
  [category: string]: boolean;
}

interface OpenAIModerationResult {
  flagged: boolean;
  categories: OpenAIModerationCategory;
}

interface OpenAIModerationResponse {
  results: OpenAIModerationResult[];
}

/**
 * Calls the OpenAI Moderation API to check for harmful content.
 * Returns the flagged status and the first triggered category.
 */
async function callOpenAIModeration(
  text: string,
  apiKey: string,
  environment: string
): Promise<ModerationResult> {
  try {
    const response = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        input: text,
        model: 'omni-moderation-latest',
      }),
    });

    if (!response.ok) {
      console.error(
        `OpenAI Moderation API error: ${response.status} ${response.statusText}`
      );
      if (environment === 'production') {
        return { flagged: false, error: true, reason: 'Moderation service unavailable' };
      }
      // Fail open in development
      return { flagged: false, error: true };
    }

    const data = (await response.json()) as OpenAIModerationResponse;
    const result = data.results[0];

    if (!result.flagged) {
      return { flagged: false };
    }

    // Find the first flagged category for the error message
    const flaggedCategory = Object.entries(result.categories).find(
      ([, flagged]) => flagged
    );

    return {
      flagged: true,
      reason: `Content flagged by moderation: ${flaggedCategory?.[0] ?? 'unknown category'}`,
    };
  } catch (err) {
    console.error('OpenAI fetch failed:', err);
    if (environment === 'production') {
      return { flagged: false, error: true, reason: 'Moderation service unreachable' };
    }
    return { flagged: false, error: true };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runs the full moderation pipeline on a gig submission.
 *
 * Checks are ordered by cost (cheapest first):
 * 1. Deterministic injection scan (free, instant)
 * 2. OpenAI moderation API (free, ~100ms)
 *
 * @param taskType   - The task_type field
 * @param payloadJson - The raw payload_json string
 * @param apiKey     - OpenAI API key
 * @param environment - The current environment (e.g., 'production')
 */
export async function moderateContent(
  taskType: string,
  payloadJson: string,
  apiKey: string,
  environment: string
): Promise<ModerationResult> {
  // Concatenate all user-provided text for scanning
  const combinedText = `${taskType} ${payloadJson}`;

  // Layer 1: Prompt injection heuristic (instant, free)
  const injectionResult = detectInjection(combinedText);
  if (injectionResult) {
    return { flagged: true, reason: injectionResult };
  }

  // Layer 2: OpenAI Moderation API
  const moderationResult = await callOpenAIModeration(combinedText, apiKey, environment);
  if (moderationResult.flagged || moderationResult.error) {
    return moderationResult;
  }

  return { flagged: false };
}
