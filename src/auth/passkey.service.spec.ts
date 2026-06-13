import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

// Replace the WebAuthn primitives with jest mocks so we can drive the verify
// outcomes without a real authenticator.
jest.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: jest.fn(),
  verifyRegistrationResponse: jest.fn(),
  generateAuthenticationOptions: jest.fn(),
  verifyAuthenticationResponse: jest.fn(),
}));
import * as webauthn from '@simplewebauthn/server';

jest.mock('argon2', () => ({
  hash: jest.fn().mockResolvedValue('hashed-refresh'),
}));

import { PasskeyService } from './passkey.service';
import { PrismaService } from '../prisma/prisma.service';
import { LoginAlertService } from './login-alert.service';

const asMock = (fn: unknown) => fn as jest.Mock;

const mockPrisma = {
  credential: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  session: {
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    deleteMany: jest.fn(),
  },
  auditLog: { create: jest.fn().mockResolvedValue({}) },
};

const mockJwt = { sign: jest.fn(), verify: jest.fn() };
const mockConfig = {
  getOrThrow: jest.fn((key: string) =>
    key === 'FRONTEND_URL' ? 'http://localhost:5173' : 'test-secret',
  ),
  get: jest.fn(() => undefined),
};
const mockLoginAlert = { handleSuccessfulLogin: jest.fn() };

describe('PasskeyService', () => {
  let service: PasskeyService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockJwt.sign.mockReturnValue('signed-token');
    mockConfig.getOrThrow.mockImplementation((key: string) =>
      key === 'FRONTEND_URL' ? 'http://localhost:5173' : 'test-secret',
    );
    mockConfig.get.mockReturnValue(undefined);
    mockPrisma.session.findMany.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PasskeyService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: JwtService, useValue: mockJwt },
        { provide: ConfigService, useValue: mockConfig },
        { provide: LoginAlertService, useValue: mockLoginAlert },
      ],
    }).compile();
    service = module.get<PasskeyService>(PasskeyService);
  });

  describe('generateRegistrationOptions', () => {
    it('derives rpID from FRONTEND_URL, excludes existing credentials and signs the challenge', async () => {
      mockPrisma.credential.findMany.mockResolvedValue([
        { credentialId: 'cred-1', transports: 'internal,hybrid' },
      ]);
      asMock(webauthn.generateRegistrationOptions).mockResolvedValue({
        challenge: 'chal-reg',
      });

      const result = await service.generateRegistrationOptions(
        'user-1',
        'a@b.com',
      );

      const regCalls = asMock(webauthn.generateRegistrationOptions).mock
        .calls as [
        [
          {
            rpID: string;
            excludeCredentials: { id: string; transports?: string[] }[];
          },
        ],
      ];
      const opts = regCalls[0][0];
      expect(opts.rpID).toBe('localhost');
      expect(opts.excludeCredentials).toEqual([
        { id: 'cred-1', transports: ['internal', 'hybrid'] },
      ]);
      expect(result.options.challenge).toBe('chal-reg');
      expect(result.challengeToken).toBe('signed-token');
      expect(mockJwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          challenge: 'chal-reg',
          purpose: 'reg',
          userId: 'user-1',
        }),
        expect.anything(),
      );
    });
  });

  describe('verifyRegistration', () => {
    it('stores a verified credential (public key base64url-encoded) and audits it', async () => {
      mockJwt.verify.mockReturnValue({
        challenge: 'chal-reg',
        purpose: 'reg',
        userId: 'user-1',
      });
      asMock(webauthn.verifyRegistrationResponse).mockResolvedValue({
        verified: true,
        registrationInfo: {
          credential: {
            id: 'new-cred',
            publicKey: new Uint8Array([1, 2, 3]),
            counter: 0,
            transports: ['internal'],
          },
          credentialDeviceType: 'multiDevice',
          credentialBackedUp: true,
        },
      });
      mockPrisma.credential.findUnique.mockResolvedValue(null);
      mockPrisma.credential.create.mockResolvedValue({
        id: 'pk-1',
        name: 'My Mac',
      });

      const result = await service.verifyRegistration(
        'user-1',
        'a@b.com',
        { id: 'new-cred' } as never,
        'challenge-token',
        'My Mac',
      );

      const createCalls = mockPrisma.credential.create.mock.calls as [
        [
          {
            data: {
              credentialId: string;
              publicKey: string;
              backedUp: boolean;
              name: string | null;
            };
          },
        ],
      ];
      const { data } = createCalls[0][0];
      expect(data.credentialId).toBe('new-cred');
      expect(data.publicKey).toBe(Buffer.from([1, 2, 3]).toString('base64url'));
      expect(data.backedUp).toBe(true);
      expect(data.name).toBe('My Mac');
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'auth.passkey_registered',
        }) as Record<string, unknown>,
      });
      expect(result).toEqual({ id: 'pk-1', name: 'My Mac' });
    });

    it('rejects when the challenge belongs to another user', async () => {
      mockJwt.verify.mockReturnValue({
        challenge: 'c',
        purpose: 'reg',
        userId: 'someone-else',
      });
      await expect(
        service.verifyRegistration(
          'user-1',
          'a@b.com',
          {} as never,
          'token',
          undefined,
        ),
      ).rejects.toThrow(UnauthorizedException);
      expect(mockPrisma.credential.create).not.toHaveBeenCalled();
    });

    it('rejects when verification fails', async () => {
      mockJwt.verify.mockReturnValue({
        challenge: 'c',
        purpose: 'reg',
        userId: 'user-1',
      });
      asMock(webauthn.verifyRegistrationResponse).mockResolvedValue({
        verified: false,
      });
      await expect(
        service.verifyRegistration(
          'user-1',
          'a@b.com',
          {} as never,
          'token',
          undefined,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('generateAuthenticationOptions', () => {
    it('returns options and signs an auth-purpose challenge', async () => {
      asMock(webauthn.generateAuthenticationOptions).mockResolvedValue({
        challenge: 'chal-auth',
      });
      const result = await service.generateAuthenticationOptions();
      expect(result.options.challenge).toBe('chal-auth');
      expect(mockJwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({ challenge: 'chal-auth', purpose: 'auth' }),
        expect.anything(),
      );
    });
  });

  describe('verifyAuthentication', () => {
    const credentialRow = {
      id: 'pk-1',
      credentialId: 'cred-x',
      publicKey: Buffer.from([9, 9]).toString('base64url'),
      counter: 2,
      transports: 'internal',
      user: {
        id: 'user-1',
        email: 'a@b.com',
        role: 'FREELANCER',
        status: 'ACTIVE',
        password: 'hash',
        twoFactorSecret: 'enc:secret',
      },
    };

    it('verifies, bumps the counter and issues a session (skipping 2FA)', async () => {
      mockJwt.verify.mockReturnValue({
        challenge: 'chal-auth',
        purpose: 'auth',
      });
      mockPrisma.credential.findUnique.mockResolvedValue(credentialRow);
      asMock(webauthn.verifyAuthenticationResponse).mockResolvedValue({
        verified: true,
        authenticationInfo: { newCounter: 3, credentialID: 'cred-x' },
      });

      const result = await service.verifyAuthentication(
        { id: 'cred-x' } as never,
        'token',
        true,
        '1.2.3.4',
        'UA',
      );

      expect(mockPrisma.credential.update).toHaveBeenCalledWith({
        where: { id: 'pk-1' },
        data: expect.objectContaining({ counter: 3 }) as Record<
          string,
          unknown
        >,
      });
      expect(mockPrisma.session.create).toHaveBeenCalled();
      expect(result.accessToken).toBeDefined();
      expect(result.user.email).toBe('a@b.com');
      expect(result.user).not.toHaveProperty('password');
      expect(result.user).not.toHaveProperty('twoFactorSecret');
      expect(result.rememberMe).toBe(true);
      expect(mockLoginAlert.handleSuccessfulLogin).toHaveBeenCalledWith(
        'auth.passkey_login',
        expect.objectContaining({ userId: 'user-1' }),
      );
    });

    it('throws when the credential is unknown', async () => {
      mockJwt.verify.mockReturnValue({ challenge: 'c', purpose: 'auth' });
      mockPrisma.credential.findUnique.mockResolvedValue(null);
      await expect(
        service.verifyAuthentication({ id: 'nope' } as never, 'token', false),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws when the assertion does not verify', async () => {
      mockJwt.verify.mockReturnValue({ challenge: 'c', purpose: 'auth' });
      mockPrisma.credential.findUnique.mockResolvedValue(credentialRow);
      asMock(webauthn.verifyAuthenticationResponse).mockResolvedValue({
        verified: false,
        authenticationInfo: {},
      });
      await expect(
        service.verifyAuthentication({ id: 'cred-x' } as never, 'token', false),
      ).rejects.toThrow(UnauthorizedException);
      expect(mockPrisma.session.create).not.toHaveBeenCalled();
    });

    it('refuses a suspended account even with a valid assertion', async () => {
      mockJwt.verify.mockReturnValue({ challenge: 'c', purpose: 'auth' });
      mockPrisma.credential.findUnique.mockResolvedValue({
        ...credentialRow,
        user: { ...credentialRow.user, status: 'SUSPENDED' },
      });
      asMock(webauthn.verifyAuthenticationResponse).mockResolvedValue({
        verified: true,
        authenticationInfo: { newCounter: 3 },
      });
      await expect(
        service.verifyAuthentication({ id: 'cred-x' } as never, 'token', false),
      ).rejects.toThrow(UnauthorizedException);
      expect(mockPrisma.session.create).not.toHaveBeenCalled();
    });
  });

  describe('removePasskey', () => {
    it('refuses to remove a passkey owned by someone else', async () => {
      mockPrisma.credential.findUnique.mockResolvedValue({
        id: 'pk-1',
        userId: 'other',
      });
      await expect(service.removePasskey('user-1', 'pk-1')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(mockPrisma.credential.delete).not.toHaveBeenCalled();
    });

    it('removes an owned passkey and audits it', async () => {
      mockPrisma.credential.findUnique.mockResolvedValue({
        id: 'pk-1',
        userId: 'user-1',
      });
      mockPrisma.credential.delete.mockResolvedValue({});
      const result = await service.removePasskey('user-1', 'pk-1');
      expect(mockPrisma.credential.delete).toHaveBeenCalledWith({
        where: { id: 'pk-1' },
      });
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'auth.passkey_removed',
        }) as Record<string, unknown>,
      });
      expect(result).toEqual({ message: 'Passkey removed' });
    });
  });
});
