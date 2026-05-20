import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { SharedLinkController } from './shared-link.controller';
import { SharedLinkService } from './shared-link.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [SharedLinkController],
  providers: [SharedLinkService],
  exports: [SharedLinkService],
})
export class SharedLinkModule {}
