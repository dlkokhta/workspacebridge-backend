import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { UserRole, UserStatus, WorkspaceStatus } from '@prisma/client';
import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminService } from './admin.service';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

class UpdateUserRoleDto {
  @ApiProperty({ enum: UserRole, example: UserRole.ADMIN })
  @IsEnum(UserRole)
  role: UserRole;
}

class UpdateUserStatusDto {
  @ApiProperty({ enum: UserStatus, example: UserStatus.SUSPENDED })
  @IsEnum(UserStatus)
  status: UserStatus;
}

class UpdateWorkspaceStatusDto {
  @ApiProperty({ enum: WorkspaceStatus, example: WorkspaceStatus.ACTIVE })
  @IsEnum(WorkspaceStatus)
  status: WorkspaceStatus;
}

@ApiTags('admin')
@ApiBearerAuth('JWT-auth')
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('stats')
  @ApiOperation({ summary: 'Get platform stats (Admin only)' })
  @ApiResponse({ status: 200, description: 'Platform statistics' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin role required' })
  public async getStats() {
    return this.adminService.getStats();
  }

  @Get('users')
  @ApiOperation({ summary: 'Get all users (Admin only)' })
  @ApiResponse({ status: 200, description: 'List of all users' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin role required' })
  public async getUsers() {
    return this.adminService.getUsers();
  }

  @Patch('users/:id/role')
  @ApiOperation({ summary: 'Update user role (Admin only)' })
  @ApiResponse({ status: 200, description: 'Role updated successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  public async updateUserRole(
    @Param('id') id: string,
    @Body() dto: UpdateUserRoleDto,
  ) {
    return this.adminService.updateUserRole(id, dto.role);
  }

  @Get('users/:id')
  @ApiOperation({ summary: 'Get user detail with workspaces, sessions, invites (Admin only)' })
  @ApiResponse({ status: 200, description: 'User detail' })
  @ApiResponse({ status: 404, description: 'User not found' })
  public async getUserDetail(@Param('id') id: string) {
    return this.adminService.getUserDetail(id);
  }

  @Patch('users/:id/status')
  @ApiOperation({ summary: 'Suspend or activate user (Admin only)' })
  @ApiResponse({ status: 200, description: 'User status updated' })
  @ApiResponse({ status: 404, description: 'User not found' })
  public async updateUserStatus(
    @Param('id') id: string,
    @Body() dto: UpdateUserStatusDto,
  ) {
    return this.adminService.updateUserStatus(id, dto.status);
  }

  @Post('users/:id/reset-password')
  @ApiOperation({ summary: 'Send password reset email to user (Admin only)' })
  @ApiResponse({ status: 200, description: 'Password reset email sent' })
  @ApiResponse({ status: 404, description: 'User not found' })
  public async adminResetPassword(@Param('id') id: string) {
    return this.adminService.adminResetPassword(id);
  }

  @Post('users/:id/force-verify')
  @ApiOperation({ summary: 'Force verify user email (Admin only)' })
  @ApiResponse({ status: 200, description: 'User email verified' })
  @ApiResponse({ status: 404, description: 'User not found' })
  public async forceVerifyUser(@Param('id') id: string) {
    return this.adminService.forceVerifyUser(id);
  }

  @Delete('users/:id')
  @ApiOperation({ summary: 'Delete user (Admin only)' })
  @ApiResponse({ status: 200, description: 'User deleted successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  public async deleteUser(@Param('id') id: string) {
    return this.adminService.deleteUser(id);
  }

  @Get('workspaces')
  @ApiOperation({ summary: 'Get all workspaces with owner and member count (Admin only)' })
  @ApiResponse({ status: 200, description: 'List of all workspaces' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin role required' })
  public async getWorkspaces() {
    return this.adminService.getWorkspaces();
  }

  @Patch('workspaces/:id/status')
  @ApiOperation({ summary: 'Update workspace status (Admin only)' })
  @ApiResponse({ status: 200, description: 'Status updated successfully' })
  @ApiResponse({ status: 404, description: 'Workspace not found' })
  public async updateWorkspaceStatus(
    @Param('id') id: string,
    @Body() dto: UpdateWorkspaceStatusDto,
  ) {
    return this.adminService.updateWorkspaceStatus(id, dto.status);
  }

  @Delete('workspaces/:id')
  @ApiOperation({ summary: 'Delete workspace (Admin only)' })
  @ApiResponse({ status: 200, description: 'Workspace deleted successfully' })
  @ApiResponse({ status: 404, description: 'Workspace not found' })
  public async deleteWorkspace(@Param('id') id: string) {
    return this.adminService.deleteWorkspace(id);
  }
}
