import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';

// Accept an upstream-supplied correlation id only if it's a sane token, so a
// reused `X-Request-Id` can't be used for log/header injection or unbounded
// growth. Anything else gets a fresh UUID.
const SAFE_ID = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * pino-http `genReqId`: derives the per-request correlation id. Reuses a valid
 * inbound `X-Request-Id` (so a trace started upstream carries through), else
 * mints a UUID. The id is echoed on the response `X-Request-Id` header for the
 * caller and returned so pino tags every log line with `req.id`.
 */
export function genRequestId(
  req: IncomingMessage,
  res: ServerResponse,
): string {
  const incoming = req.headers['x-request-id'];
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  const id = candidate && SAFE_ID.test(candidate) ? candidate : randomUUID();
  res.setHeader('X-Request-Id', id);
  return id;
}
