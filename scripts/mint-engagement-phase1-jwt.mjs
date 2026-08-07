#!/usr/bin/env node
/**
 * Mint a Clerk Backend API JWT for local Phase 1 acceptance.
 *
 * Uses CLERK_SECRET_KEY to create a session and mint a token via the
 * Clerk Backend API. Writes the JWT to ENGAGEMENT_PHASE1_TOKEN_FILE.
 * Used when browser-based Clerk authentication is not available.
 */
import { writeFile } from 'node:fs/promises';

const secret = process.env.CLERK_SECRET_KEY?.trim();
const userId = (
  process.env.ENGAGEMENT_PHASE1_USER_CLERK_ID ||
  process.env.ENGAGEMENT_PHASE0_USER_CLERK_ID ||
  ''
).trim();
const tokenFile = process.env.ENGAGEMENT_PHASE1_TOKEN_FILE;

if (!secret || !userId || !tokenFile) {
  console.error('CLERK_SECRET_KEY, ENGAGEMENT_PHASE1_USER_CLERK_ID, and ENGAGEMENT_PHASE1_TOKEN_FILE are required');
  process.exit(2);
}

async function clerkRequest(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, body: json };
}

// Create a session
const session = await clerkRequest('POST', 'https://api.clerk.com/v1/sessions', { user_id: userId });
if (session.status >= 300 || !session.body?.id) {
  console.error(`Session creation failed: status=${session.status}, body=${JSON.stringify(session.body).slice(0, 200)}`);
  process.exit(1);
}

// Mint a token for the session
const token = await clerkRequest('POST', `https://api.clerk.com/v1/sessions/${session.body.id}/tokens`);
if (token.status >= 300 || !token.body?.jwt) {
  console.error(`Token mint failed: status=${token.status}, body=${JSON.stringify(token.body).slice(0, 200)}`);
  process.exit(1);
}

await writeFile(tokenFile, token.body.jwt, { mode: 0o600 });
console.log('minted_bearer_token_ok');
console.error(`minted_session=${session.body.id}`);
