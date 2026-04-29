import { Module } from '@nestjs/common';
import { WorkspaceService } from './workspace.service';
import { WorkspaceController } from './workspace.controller';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [WorkspaceController],
  providers: [PrismaService, WorkspaceService],
})
export class WorkspaceModule {}
