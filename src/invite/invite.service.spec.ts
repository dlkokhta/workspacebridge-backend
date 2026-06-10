import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { InviteService } from './invite.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { PasswordBreachService } from '../libs/common/services/password-breach.service';

jest.mock('argon2');

const mockedHash = argon2.hash as jest.MockedFunction<typeof argon2.hash>;

const fakeInvite = {
  token: 'invite-token',
  email: 'client@example.com',
  usedAt: null,
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  workspace: { id: 'ws-1', name: 'Acme', color: '#5a8a6b', description: null },
};

const mockPrismaService = {
  workspaceInvite: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  user: {
    findUnique: jest.fn(),
    create: jest.fn(),
  },
  workspaceMember: {
    create: jest.fn(),
  },
  session: {
    create: jest.fn(),
  },
};

const mockMailService = {
  sendWorkspaceInviteEmail: jest.fn(),
};

const mockJwtService = {
  sign: jest.fn(),
};

const mockConfigService = {
  get: jest.fn().mockReturnValue(undefined),
  getOrThrow: jest.fn().mockReturnValue('test-jwt-secret'),
};

const mockPasswordBreachService = {
  isBreached: jest.fn().mockResolvedValue(false),
};

describe('InviteService', () => {
  let service: InviteService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InviteService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: MailService, useValue: mockMailService },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: PasswordBreachService, useValue: mockPasswordBreachService },
      ],
    }).compile();

    service = module.get<InviteService>(InviteService);
    jest.clearAllMocks();
  });

  // ─── acceptInvite ───────────────────────────────────────────────────────────

  describe('acceptInvite', () => {
    it('rejects a breached password without creating the user or burning the invite', async () => {
      mockPrismaService.workspaceInvite.findUnique.mockResolvedValue(
        fakeInvite,
      );
      mockPrismaService.user.findUnique.mockResolvedValue(null);
      mockPasswordBreachService.isBreached.mockResolvedValueOnce(true);

      await expect(
        service.acceptInvite('invite-token', { password: 'breached-pass' }),
      ).rejects.toThrow(
        new BadRequestException(
          'This password has appeared in a known data breach. Please choose a different one.',
        ),
      );

      expect(mockPasswordBreachService.isBreached).toHaveBeenCalledWith(
        'breached-pass',
      );
      expect(mockPrismaService.user.create).not.toHaveBeenCalled();
      // The invite stays unused so the client can retry with a stronger password.
      expect(mockPrismaService.workspaceInvite.update).not.toHaveBeenCalled();
    });

    it('creates the client account and session when the password is not breached', async () => {
      mockPrismaService.workspaceInvite.findUnique.mockResolvedValue(
        fakeInvite,
      );
      mockPrismaService.user.findUnique.mockResolvedValue(null);
      mockedHash.mockResolvedValue('hashed' as never);
      mockPrismaService.user.create.mockResolvedValue({
        id: 'user-1',
        email: 'client@example.com',
        role: 'CLIENT',
      });
      mockPrismaService.workspaceMember.create.mockResolvedValue({});
      mockPrismaService.workspaceInvite.update.mockResolvedValue({});
      mockJwtService.sign
        .mockReturnValueOnce('access-token')
        .mockReturnValueOnce('refresh-token');
      mockPrismaService.session.create.mockResolvedValue({});

      const result = await service.acceptInvite('invite-token', {
        password: 'Strong-unique-pass-42',
      });

      expect(mockPasswordBreachService.isBreached).toHaveBeenCalledWith(
        'Strong-unique-pass-42',
      );
      expect(mockPrismaService.user.create).toHaveBeenCalled();
      expect(result).toMatchObject({
        accessToken: 'access-token',
        workspaceId: 'ws-1',
      });
    });
  });
});
