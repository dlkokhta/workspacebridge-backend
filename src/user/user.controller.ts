import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { UserService } from './user.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { SetPasswordDto } from './dto/set-password.dto';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { ActivityQueryDto } from './dto/activity-query.dto';

@ApiTags('user')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'Returns the current user profile' })
  @Get('me')
  getProfile(@Req() req: Request) {
    return this.userService.getProfile((req.user as any).id);
  }

  @ApiOperation({ summary: 'Update profile (firstName, lastName)' })
  @ApiResponse({ status: 200, description: 'Returns the updated profile' })
  @Patch('me')
  updateProfile(@Req() req: Request, @Body() dto: UpdateProfileDto) {
    return this.userService.updateProfile((req.user as any).id, dto);
  }

  @ApiOperation({ summary: 'Change password' })
  @ApiResponse({ status: 200, description: 'Password changed successfully' })
  @Patch('me/password')
  changePassword(@Req() req: Request, @Body() dto: ChangePasswordDto) {
    return this.userService.changePassword((req.user as any).id, dto);
  }

  @ApiOperation({ summary: 'Permanently delete the current account' })
  @ApiResponse({ status: 200, description: 'Account permanently deleted' })
  @ApiResponse({ status: 400, description: 'Password is required' })
  @ApiResponse({ status: 401, description: 'Password is incorrect' })
  @Delete('me')
  @HttpCode(HttpStatus.OK)
  async deleteAccount(@Req() req: Request, @Body() dto: DeleteAccountDto) {
    await this.userService.deleteOwnAccount((req.user as any).id, dto.password);
    return { message: 'Your account has been permanently deleted.' };
  }

  @ApiOperation({ summary: 'Export all personal data (GDPR)' })
  @ApiResponse({
    status: 200,
    description: 'Returns a downloadable JSON snapshot of the user data',
  })
  @Get('me/export')
  async exportData(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const data = await this.userService.exportOwnData((req.user as any).id);
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="workspacebridge-data-export-${date}.json"`,
    );
    return data;
  }

  @ApiOperation({ summary: 'Account activity timeline (auth events)' })
  @ApiResponse({
    status: 200,
    description: 'Returns the paginated auth activity for the current user',
  })
  @Get('me/activity')
  getActivity(@Req() req: Request, @Query() query: ActivityQueryDto) {
    return this.userService.getActivity(
      (req.user as any).id,
      query.page,
      query.limit,
    );
  }

  // ── Sign-in methods (linked accounts) ──────────────────────────────────────

  @ApiOperation({ summary: 'List the current user sign-in methods' })
  @ApiResponse({
    status: 200,
    description: 'Returns hasPassword and linked providers',
  })
  @Get('me/sign-in-methods')
  getSignInMethods(@Req() req: Request) {
    return this.userService.getSignInMethods((req.user as any).id);
  }

  @ApiOperation({ summary: 'Set a password for an account that has none (OAuth)' })
  @ApiResponse({ status: 200, description: 'Password set successfully' })
  @ApiResponse({ status: 400, description: 'A password is already set' })
  @Post('me/password/set')
  @HttpCode(HttpStatus.OK)
  async setPassword(@Req() req: Request, @Body() dto: SetPasswordDto) {
    await this.userService.setPassword((req.user as any).id, dto.newPassword);
    return { message: 'Password set successfully' };
  }

  @ApiOperation({ summary: 'Disconnect a linked OAuth provider' })
  @ApiResponse({ status: 200, description: 'Provider disconnected' })
  @ApiResponse({ status: 400, description: 'Cannot remove the only sign-in method' })
  @ApiResponse({ status: 404, description: 'Provider not linked' })
  @Delete('me/accounts/:provider')
  disconnectProvider(@Param('provider') provider: string, @Req() req: Request) {
    return this.userService.disconnectProvider(
      (req.user as any).id,
      provider.toLowerCase(),
    );
  }

  // ── Sessions ────────────────────────────────────────────────────────────

  @ApiOperation({ summary: 'List active sessions for the current user' })
  @ApiResponse({
    status: 200,
    description: 'Returns active sessions; the current one is flagged',
  })
  @Get('sessions')
  getSessions(@Req() req: Request) {
    return this.userService.getSessions(
      (req.user as any).id,
      req.cookies?.['refreshToken'],
    );
  }

  @ApiOperation({ summary: 'Revoke all sessions except the current one' })
  @ApiResponse({ status: 200, description: 'Other sessions revoked' })
  @Delete('sessions')
  revokeOtherSessions(@Req() req: Request) {
    return this.userService.revokeOtherSessions(
      (req.user as any).id,
      req.cookies?.['refreshToken'],
    );
  }

  @ApiOperation({ summary: 'Revoke a specific session by id' })
  @ApiResponse({ status: 200, description: 'Session revoked' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  @Delete('sessions/:id')
  revokeSession(@Req() req: Request, @Param('id') id: string) {
    return this.userService.revokeSession((req.user as any).id, id);
  }
}

