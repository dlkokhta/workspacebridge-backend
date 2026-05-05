import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { WorkspaceService } from './workspace.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
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

  @Get(':id')
  @ApiOperation({ summary: 'Get a single workspace by ID' })
  @ApiResponse({ status: 200, description: 'Returns the workspace' })
  @ApiResponse({ status: 404, description: 'Workspace not found' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  findOne(@Req() req: Request, @Param('id') id: string) {
    return this.workspaceService.findOne(id, (req.user as any).id, (req.user as any).role);
  }

  @Patch(':id')
  @Roles(UserRole.FREELANCER)
  @ApiOperation({ summary: 'Update workspace name, description, color or status' })
  @ApiResponse({ status: 200, description: 'Workspace updated' })
  @ApiResponse({ status: 404, description: 'Workspace not found' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateWorkspaceDto) {
    return this.workspaceService.update(id, (req.user as any).id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.FREELANCER)
  @ApiOperation({ summary: 'Delete a workspace' })
  @ApiResponse({ status: 200, description: 'Workspace deleted' })
  @ApiResponse({ status: 404, description: 'Workspace not found' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  remove(@Req() req: Request, @Param('id') id: string) {
    return this.workspaceService.remove(id, (req.user as any).id);
  }

  @Delete(':id/members/:userId')
  @Roles(UserRole.FREELANCER)
  @ApiOperation({ summary: 'Remove a member from a workspace' })
  @ApiResponse({ status: 200, description: 'Member removed' })
  @ApiResponse({ status: 404, description: 'Workspace or member not found' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  removeMember(@Req() req: Request, @Param('id') id: string, @Param('userId') userId: string) {
    return this.workspaceService.removeMember(id, userId, (req.user as any).id);
  }
}
