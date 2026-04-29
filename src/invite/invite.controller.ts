import { Body, Controller, Get, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { InviteService } from './invite.service';
import { SendInviteDto } from './dto/send-invite.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';

@ApiTags('invite')
@Controller()
export class InviteController {
  constructor(private readonly inviteService: InviteService) {}

  @Post('workspace/:id/invite')
  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.FREELANCER)
  @ApiOperation({ summary: 'Send email invite to a client' })
  sendInvite(
    @Req() req: Request,
    @Param('id') workspaceId: string,
    @Body() dto: SendInviteDto,
  ) {
    return this.inviteService.sendInvite(workspaceId, (req.user as any).id, dto);
  }

  @Post('workspace/:id/invite/link')
  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.FREELANCER)
  @ApiOperation({ summary: 'Generate a shareable invite link' })
  generateLink(@Req() req: Request, @Param('id') workspaceId: string) {
    return this.inviteService.generateLink(workspaceId, (req.user as any).id);
  }

  @Get('invite/:token')
  @ApiOperation({ summary: 'Validate invite token and return workspace info' })
  getInvite(@Param('token') token: string) {
    return this.inviteService.getInvite(token);
  }

  @Post('invite/:token/accept')
  @ApiOperation({ summary: 'Accept invite — create client account and join workspace' })
  async acceptInvite(
    @Param('token') token: string,
    @Body() dto: AcceptInviteDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.inviteService.acceptInvite(
      token,
      dto,
      req.ip,
      req.headers['user-agent'],
    );

    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return {
      accessToken: result.accessToken,
      user: result.user,
      workspaceId: result.workspaceId,
    };
  }
}
