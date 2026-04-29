import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { InviteService } from './invite.service';
import { InviteController } from './invite.controller';

@Module({
  imports: [JwtModule.register({})],
  providers: [PrismaService, MailService, InviteService],
  controllers: [InviteController],
})
export class InviteModule {}
