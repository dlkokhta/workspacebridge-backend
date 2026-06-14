import 'reflect-metadata';
import { validateEnv } from './env.validation';

// A minimal env that satisfies every required var; tests tweak one field.
const baseEnv = (): Record<string, string> => ({
  NODE_ENV: 'development',
  APPLICATION_PORT: '4002',
  POSTGRES_URL: 'postgresql://user:pass@localhost:5432/db',
  ALLOWED_ORIGIN: 'http://localhost:5173',
  FRONTEND_URL: 'http://localhost:5173',
  JWT_SECRET: 'a'.repeat(32),
  R2_ACCOUNT_ID: 'acc',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET: 'bucket',
});

describe('validateEnv', () => {
  it('passes and returns the original config for a valid environment', () => {
    const env = { ...baseEnv(), SOME_EXTRA_VAR: 'kept' };
    const result = validateEnv(env);
    // Undeclared vars must survive so ConfigService can still read them.
    expect(result).toBe(env);
    expect(result.SOME_EXTRA_VAR).toBe('kept');
  });

  it('throws when JWT_SECRET is shorter than 32 characters', () => {
    const env = { ...baseEnv(), JWT_SECRET: 'a'.repeat(31) };
    expect(() => validateEnv(env)).toThrow(/JWT_SECRET must be at least 32/);
  });

  it('throws when a required var is missing', () => {
    const env = baseEnv();
    delete (env as Partial<typeof env>).POSTGRES_URL;
    expect(() => validateEnv(env)).toThrow(/POSTGRES_URL/);
  });

  it('throws when NODE_ENV is not a known environment', () => {
    const env = { ...baseEnv(), NODE_ENV: 'staging' };
    expect(() => validateEnv(env)).toThrow(/NODE_ENV must be one of/);
  });

  it('throws when APPLICATION_PORT is not numeric', () => {
    const env = { ...baseEnv(), APPLICATION_PORT: 'not-a-port' };
    expect(() => validateEnv(env)).toThrow(/APPLICATION_PORT/);
  });

  it('throws when POSTGRES_URL is not a postgres connection string', () => {
    const env = { ...baseEnv(), POSTGRES_URL: 'mysql://localhost/db' };
    expect(() => validateEnv(env)).toThrow(/POSTGRES_URL/);
  });

  it('accepts a missing ENCRYPTION_KEY (optional) but rejects a malformed one', () => {
    expect(() => validateEnv(baseEnv())).not.toThrow();
    const env = { ...baseEnv(), ENCRYPTION_KEY: 'too-short' };
    expect(() => validateEnv(env)).toThrow(/ENCRYPTION_KEY must be 32 bytes/);
  });

  it('rejects a JWT_REFRESH_SECRET that is set but too short', () => {
    const env = { ...baseEnv(), JWT_REFRESH_SECRET: 'short' };
    expect(() => validateEnv(env)).toThrow(/JWT_REFRESH_SECRET/);
  });
});
