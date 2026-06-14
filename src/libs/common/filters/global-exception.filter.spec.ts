import {
  ArgumentsHost,
  BadRequestException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { GlobalExceptionFilter } from './global-exception.filter';

interface MockResponse {
  status: jest.Mock;
  json: jest.Mock;
}

const makeResponse = (): MockResponse => {
  const res: MockResponse = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
};

const makeHttpHost = (
  res: MockResponse,
  req: Record<string, unknown> = {},
): ArgumentsHost =>
  ({
    getType: () => 'http',
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({
        method: 'GET',
        originalUrl: '/test',
        headers: {},
        id: 'req-123',
        ...req,
      }),
    }),
  }) as unknown as ArgumentsHost;

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('shapes an HttpException with errorCode, path and requestId', () => {
    const res = makeResponse();
    filter.catch(new NotFoundException('User not found'), makeHttpHost(res));

    expect(res.status).toHaveBeenCalledWith(404);
    const body = res.json.mock.calls[0][0];
    expect(body).toEqual(
      expect.objectContaining({
        statusCode: 404,
        errorCode: 'NOT_FOUND',
        message: 'User not found',
        path: '/test',
        requestId: 'req-123',
      }),
    );
    expect(typeof body.timestamp).toBe('string');
  });

  it('preserves a validation message array', () => {
    const res = makeResponse();
    filter.catch(
      new BadRequestException(['email must be an email', 'name is required']),
      makeHttpHost(res),
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        errorCode: 'BAD_REQUEST',
        message: ['email must be an email', 'name is required'],
      }),
    );
  });

  it('maps Prisma unique-constraint (P2002) to 409 CONFLICT', () => {
    const res = makeResponse();
    const err = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: '6.0.0',
    });

    filter.catch(err, makeHttpHost(res));

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0]).toEqual(
      expect.objectContaining({ errorCode: 'CONFLICT' }),
    );
  });

  it('maps Prisma not-found (P2025) to 404 NOT_FOUND', () => {
    const res = makeResponse();
    const err = new Prisma.PrismaClientKnownRequestError('missing', {
      code: 'P2025',
      clientVersion: '6.0.0',
    });

    filter.catch(err, makeHttpHost(res));

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0]).toEqual(
      expect.objectContaining({ errorCode: 'NOT_FOUND' }),
    );
  });

  it('hides internals of an unknown error behind a generic 500', () => {
    const res = makeResponse();
    filter.catch(new Error('secret db dsn leaked'), makeHttpHost(res));

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.errorCode).toBe('INTERNAL_SERVER_ERROR');
    expect(body.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('secret db dsn leaked');
  });

  it('falls back to the x-request-id header when req.id is absent', () => {
    const res = makeResponse();
    filter.catch(
      new NotFoundException(),
      makeHttpHost(res, { id: undefined, headers: { 'x-request-id': 'hdr-9' } }),
    );

    expect(res.json.mock.calls[0][0].requestId).toBe('hdr-9');
  });

  it('ignores non-HTTP (websocket) contexts without writing a response', () => {
    const res = makeResponse();
    const wsHost = {
      getType: () => 'ws',
      switchToHttp: () => ({
        getResponse: () => res,
        getRequest: () => ({}),
      }),
    } as unknown as ArgumentsHost;

    filter.catch(new Error('ws boom'), wsHost);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});
