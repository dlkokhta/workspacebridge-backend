import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
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

  private actorId(req: Request): string {
    return (req.user as { id: string }).id;
  }

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

  @Get('users/:id')
  @ApiOperation({ summary: 'Get user detail with workspaces, sessions, invites (Admin only)' })
  @ApiResponse({ status: 200, description: 'User detail' })
  @ApiResponse({ status: 404, description: 'User not found' })
  public async getUserDetail(@Param('id') id: string) {
    return this.adminService.getUserDetail(id);
  }

  @Patch('users/:id/role')
  @ApiOperation({ summary: 'Update user role (Admin only)' })
  @ApiResponse({ status: 200, description: 'Role updated successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  public async updateUserRole(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateUserRoleDto,
  ) {
    return this.adminService.updateUserRole(id, dto.role, this.actorId(req));
  }

  @Patch('users/:id/status')
  @ApiOperation({ summary: 'Suspend or activate user (Admin only)' })
  @ApiResponse({ status: 200, description: 'User status updated' })
  @ApiResponse({ status: 404, description: 'User not found' })
  public async updateUserStatus(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateUserStatusDto,
  ) {
    return this.adminService.updateUserStatus(id, dto.status, this.actorId(req));
  }

  @Post('users/:id/reset-password')
  @ApiOperation({ summary: 'Send password reset email to user (Admin only)' })
  @ApiResponse({ status: 200, description: 'Password reset email sent' })
  @ApiResponse({ status: 404, description: 'User not found' })
  public async adminResetPassword(@Req() req: Request, @Param('id') id: string) {
    return this.adminService.adminResetPassword(id, this.actorId(req));
  }

  @Post('users/:id/force-verify')
  @ApiOperation({ summary: 'Force verify user email (Admin only)' })
  @ApiResponse({ status: 200, description: 'User email verified' })
  @ApiResponse({ status: 404, description: 'User not found' })
  public async forceVerifyUser(@Req() req: Request, @Param('id') id: string) {
    return this.adminService.forceVerifyUser(id, this.actorId(req));
  }

  @Delete('users/:id')
  @ApiOperation({ summary: 'Delete user (Admin only)' })
  @ApiResponse({ status: 200, description: 'User deleted successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  public async deleteUser(@Req() req: Request, @Param('id') id: string) {
    return this.adminService.deleteUser(id, this.actorId(req));
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
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateWorkspaceStatusDto,
  ) {
    return this.adminService.updateWorkspaceStatus(id, dto.status, this.actorId(req));
  }

  @Delete('workspaces/:id')
  @ApiOperation({ summary: 'Delete workspace (Admin only)' })
  @ApiResponse({ status: 200, description: 'Workspace deleted successfully' })
  @ApiResponse({ status: 404, description: 'Workspace not found' })
  public async deleteWorkspace(@Req() req: Request, @Param('id') id: string) {
    return this.adminService.deleteWorkspace(id, this.actorId(req));
  }

  @Get('invites')
  @ApiOperation({ summary: 'Get all invites across the platform (Admin only)' })
  @ApiResponse({ status: 200, description: 'List of all invites' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin role required' })
  public async getInvites() {
    return this.adminService.getInvites();
  }

  @Delete('invites/:id')
  @ApiOperation({ summary: 'Revoke an invite (Admin only)' })
  @ApiResponse({ status: 200, description: 'Invite revoked successfully' })
  @ApiResponse({ status: 404, description: 'Invite not found' })
  public async deleteInvite(@Req() req: Request, @Param('id') id: string) {
    return this.adminService.deleteInvite(id, this.actorId(req));
  }

  @Get('sessions')
  @ApiOperation({ summary: 'Get all active sessions (Admin only)' })
  @ApiResponse({ status: 200, description: 'List of all sessions' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin role required' })
  public async getSessions() {
    return this.adminService.getSessions();
  }

  @Delete('sessions/:id')
  @ApiOperation({ summary: 'Revoke a session / force logout (Admin only)' })
  @ApiResponse({ status: 200, description: 'Session revoked successfully' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  public async deleteSession(@Req() req: Request, @Param('id') id: string) {
    return this.adminService.deleteSession(id, this.actorId(req));
  }

  @Get('files')
  @ApiOperation({ summary: 'Get all files across the platform (Admin only)' })
  @ApiResponse({ status: 200, description: 'List of all files' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin role required' })
  public async getFiles() {
    return this.adminService.getFiles();
  }

  @Get('files/stats')
  @ApiOperation({ summary: 'Get file storage stats (Admin only)' })
  @ApiResponse({ status: 200, description: 'File storage statistics' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin role required' })
  public async getFileStats() {
    return this.adminService.getFileStats();
  }

  @Delete('files/:id')
  @ApiOperation({ summary: 'Permanently delete a file (Admin only)' })
  @ApiResponse({ status: 200, description: 'File deleted successfully' })
  @ApiResponse({ status: 404, description: 'File not found' })
  public async deleteFile(@Req() req: Request, @Param('id') id: string) {
    return this.adminService.deleteFile(id, this.actorId(req));
  }

  @Get('audit-log')
  @ApiOperation({ summary: 'Get audit log (Admin only)' })
  @ApiResponse({ status: 200, description: 'Audit log entries' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin role required' })
  public async getAuditLog() {
    return this.adminService.getAuditLog();
  }

  @Get('settings')
  @ApiOperation({ summary: 'Get all platform settings (Admin only)' })
  @ApiResponse({ status: 200, description: 'Platform settings' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin role required' })
  public async getSettings() {
    return this.adminService.getSettings();
  }

  @Patch('settings/:key')
  @ApiOperation({ summary: 'Update a platform setting (Admin only)' })
  @ApiResponse({ status: 200, description: 'Setting updated' })
  @ApiResponse({ status: 404, description: 'Setting not found' })
  public async updateSetting(
    @Req() req: Request,
    @Param('key') key: string,
    @Body('value') value: unknown,
  ) {
    return this.adminService.updateSetting(key, value, this.actorId(req));
  }
}
