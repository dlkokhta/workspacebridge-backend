import { plainToInstance, Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

/**
 * Schema for the environment the app boots with. Anything the code reads with
 * `getOrThrow` at startup is required here too, so a missing/invalid value
 * fails fast with a clear message instead of crashing lazily later. Optional
 * vars are only format-checked when present. Secrets carry a minimum length.
 */
export class EnvironmentVariables {
  @IsEnum(Environment, {
    message: 'NODE_ENV must be one of: development, production, test',
  })
  NODE_ENV!: Environment;

  @Type(() => Number)
  @IsInt({ message: 'APPLICATION_PORT must be an integer' })
  @Min(1)
  @Max(65535)
  APPLICATION_PORT!: number;

  @IsString()
  @Matches(/^postgres(ql)?:\/\//, {
    message: 'POSTGRES_URL must be a postgres:// connection string',
  })
  POSTGRES_URL!: string;

  @IsString()
  @IsNotEmpty()
  ALLOWED_ORIGIN!: string;

  @IsString()
  @IsNotEmpty()
  FRONTEND_URL!: string;

  @IsString()
  @MinLength(32, { message: 'JWT_SECRET must be at least 32 characters' })
  JWT_SECRET!: string;

  // Object storage (Cloudflare R2) — the storage service reads these with
  // getOrThrow at startup, so they are required.
  @IsString()
  @IsNotEmpty()
  R2_ACCOUNT_ID!: string;

  @IsString()
  @IsNotEmpty()
  R2_ACCESS_KEY_ID!: string;

  @IsString()
  @IsNotEmpty()
  R2_SECRET_ACCESS_KEY!: string;

  @IsString()
  @IsNotEmpty()
  R2_BUCKET!: string;

  // ── Optional: validated only when provided ────────────────────────────────

  // Falls back to JWT_SECRET when unset, so it is optional — but if set it must
  // be just as strong.
  @IsOptional()
  @IsString()
  @MinLength(32, {
    message: 'JWT_REFRESH_SECRET, when set, must be at least 32 characters',
  })
  JWT_REFRESH_SECRET?: string;

  @IsOptional()
  @IsString()
  JWT_ACCESS_EXPIRES_IN?: string;

  @IsOptional()
  @IsString()
  JWT_REFRESH_EXPIRES_IN?: string;

  // 32 raw bytes, base64-encoded (44 chars) — for at-rest encryption of 2FA
  // secrets. Lazily required by the crypto util; format-checked here if present.
  @IsOptional()
  @Matches(/^[A-Za-z0-9+/]{43}=$/, {
    message: 'ENCRYPTION_KEY must be 32 bytes base64-encoded (44 characters)',
  })
  ENCRYPTION_KEY?: string;

  @IsOptional()
  @IsString()
  GOOGLE_CLIENT_ID?: string;

  @IsOptional()
  @IsString()
  GOOGLE_CLIENT_SECRET?: string;

  @IsOptional()
  @IsString()
  GOOGLE_CALLBACK_URL?: string;

  @IsOptional()
  @IsString()
  RESEND_API_KEY?: string;

  @IsOptional()
  @IsString()
  RESEND_FROM_EMAIL?: string;

  @IsOptional()
  @IsString()
  REDIS_URL?: string;

  @IsOptional()
  @IsString()
  TRUST_PROXY?: string;

  @IsOptional()
  @IsIn(['lax', 'strict', 'none'], {
    message: 'COOKIE_SAMESITE must be one of: lax, strict, none',
  })
  COOKIE_SAMESITE?: string;

  @IsOptional()
  @IsString()
  WEBAUTHN_ORIGIN?: string;

  @IsOptional()
  @IsString()
  WEBAUTHN_RP_ID?: string;

  @IsOptional()
  @IsString()
  WEBAUTHN_RP_NAME?: string;
}

/**
 * ConfigModule `validate` hook: throws (fail-fast) on any invalid/missing
 * required env var. Returns the original env untouched so undeclared vars stay
 * available through ConfigService — the class is only a validation gate.
 */
export function validateEnv(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validated, {
    skipMissingProperties: false,
    forbidUnknownValues: false,
  });

  if (errors.length > 0) {
    const messages = errors
      .flatMap((e) => Object.values(e.constraints ?? {}))
      .join('\n  - ');
    throw new Error(`Invalid environment configuration:\n  - ${messages}`);
  }

  return config;
}
