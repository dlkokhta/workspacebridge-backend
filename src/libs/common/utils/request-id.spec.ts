import type { IncomingMessage, ServerResponse } from 'http';
import { genRequestId } from './request-id';

const makeReq = (headers: Record<string, string | string[]> = {}) =>
  ({ headers }) as unknown as IncomingMessage;

const makeRes = () => {
  const setHeader = jest.fn();
  return { res: { setHeader } as unknown as ServerResponse, setHeader };
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('genRequestId', () => {
  it('mints a UUID and echoes it on the response when no header is present', () => {
    const { res, setHeader } = makeRes();

    const id = genRequestId(makeReq(), res);

    expect(id).toMatch(UUID_RE);
    expect(setHeader).toHaveBeenCalledWith('X-Request-Id', id);
  });

  it('reuses a valid inbound X-Request-Id (upstream propagation)', () => {
    const { res, setHeader } = makeRes();

    const id = genRequestId(makeReq({ 'x-request-id': 'trace-abc-123' }), res);

    expect(id).toBe('trace-abc-123');
    expect(setHeader).toHaveBeenCalledWith('X-Request-Id', 'trace-abc-123');
  });

  it('rejects an unsafe inbound id and mints a UUID instead', () => {
    const { res } = makeRes();

    const tooShort = genRequestId(makeReq({ 'x-request-id': 'short' }), res);
    const withCRLF = genRequestId(
      makeReq({ 'x-request-id': 'bad\r\nInjected: 1' }),
      makeRes().res,
    );

    expect(tooShort).toMatch(UUID_RE);
    expect(withCRLF).toMatch(UUID_RE);
  });

  it('uses the first value when the header is an array', () => {
    const { res } = makeRes();

    const id = genRequestId(
      makeReq({ 'x-request-id': ['trace-first-value', 'second'] }),
      res,
    );

    expect(id).toBe('trace-first-value');
  });
});
