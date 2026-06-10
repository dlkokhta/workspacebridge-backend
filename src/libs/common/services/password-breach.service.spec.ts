import { PasswordBreachService } from './password-breach.service';

// SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
// prefix = 5BAA6, suffix = 1E4C9B93F3F0682250B6CF8331B7EE68FD8
const PASSWORD_SUFFIX = '1E4C9B93F3F0682250B6CF8331B7EE68FD8';

describe('PasswordBreachService', () => {
  let service: PasswordBreachService;
  const originalFetch = global.fetch;

  beforeEach(() => {
    service = new PasswordBreachService();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('detects a breached password and only sends the 5-char prefix (k-anonymity)', async () => {
    const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn();
    fetchMock.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(`${PASSWORD_SUFFIX}:99999\nABCDEF:3`),
    } as unknown as Response);
    global.fetch = fetchMock;

    expect(await service.getBreachCount('password')).toBe(99999);
    expect(await service.isBreached('password')).toBe(true);

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/range/5BAA6');
    // k-anonymity: the full hash suffix is never sent to the API
    expect(calledUrl).not.toContain(PASSWORD_SUFFIX);
  });

  it('returns 0 when the suffix is not in the range', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('AAAA1111:1\nBBBB2222:2'),
    }) as unknown as typeof fetch;

    expect(await service.getBreachCount('password')).toBe(0);
    expect(await service.isBreached('password')).toBe(false);
  });

  it('fails open (returns 0) when the API is unreachable', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    expect(await service.getBreachCount('password')).toBe(0);
  });

  it('fails open when the API responds with a non-OK status', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;
    expect(await service.getBreachCount('password')).toBe(0);
  });
});
