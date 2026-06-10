import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { CsrfGuard } from './csrf.guard';

const contextFor = (
  cookies: Record<string, string>,
  headers: Record<string, string | string[]>,
): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ cookies, headers }),
    }),
  }) as unknown as ExecutionContext;

describe('CsrfGuard', () => {
  let guard: CsrfGuard;

  beforeEach(() => {
    guard = new CsrfGuard();
  });

  it('allows the request when cookie and header match', () => {
    const ctx = contextFor(
      { csrfToken: 'token-123' },
      { 'x-csrf-token': 'token-123' },
    );
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects when the CSRF cookie is missing', () => {
    const ctx = contextFor({}, { 'x-csrf-token': 'token-123' });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('rejects when the X-CSRF-Token header is missing', () => {
    const ctx = contextFor({ csrfToken: 'token-123' }, {});
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('rejects when cookie and header do not match', () => {
    const ctx = contextFor(
      { csrfToken: 'token-123' },
      { 'x-csrf-token': 'token-456' },
    );
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('rejects when values differ in length (no timingSafeEqual throw)', () => {
    const ctx = contextFor(
      { csrfToken: 'token-123' },
      { 'x-csrf-token': 'token-123-longer' },
    );
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('uses the first value when the header arrives as an array', () => {
    const ctx = contextFor(
      { csrfToken: 'token-123' },
      { 'x-csrf-token': ['token-123', 'other'] },
    );
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
