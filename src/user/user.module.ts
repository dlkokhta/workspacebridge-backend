import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { PrismaService } from 'src/prisma/prisma.service';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PasswordBreachService } from '../libs/common/services/password-breach.service';
import { PasswordHistoryService } from '../libs/common/services/password-history.service';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [
    MailModule,
    // JwtService is needed to read the sessionId claim out of the refresh
    // cookie when the sessions endpoints flag the caller's own session.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [UserController],
  providers: [
    PrismaService,
    UserService,
    PasswordBreachService,
    PasswordHistoryService,
  ],
  exports: [UserService],
})
export class UserModule {}
