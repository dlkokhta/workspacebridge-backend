import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { WorkspaceService } from './workspace.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '@prisma/client';

@ApiTags('workspace')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('workspace')
export class WorkspaceController {
  constructor(private readonly workspaceService: WorkspaceService) {}

  @Post()
  @Roles(UserRole.FREELANCER)
  @ApiOperation({ summary: 'Create a new workspace' })
  @ApiResponse({ status: 201, description: 'Workspace created' })
  create(@Req() req: Request, @Body() dto: CreateWorkspaceDto) {
    return this.workspaceService.create((req.user as any).id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List workspaces for the current user' })
  @ApiResponse({ status: 200, description: 'Returns all workspaces' })
  findAll(@Req() req: Request) {
    return this.workspaceService.findAll((req.user as any).id, (req.user as any).role);
  }
}
