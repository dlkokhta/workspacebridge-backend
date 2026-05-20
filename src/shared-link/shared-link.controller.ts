import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { SharedLinkService } from './shared-link.service';
import { CreateSharedLinkDto } from './dto/create-shared-link.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

type RequestUser = { id: string; role: UserRole };

@ApiTags('shared-link')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller()
export class SharedLinkController {
  constructor(private readonly sharedLinkService: SharedLinkService) {}

  @Get('workspace/:workspaceId/links')
  @ApiOperation({ summary: 'List shared links in a workspace' })
  @ApiResponse({ status: 200, description: 'Returns links with addedBy' })
  list(@Req() req: Request, @Param('workspaceId') workspaceId: string) {
    const user = req.user as RequestUser;
    return this.sharedLinkService.list(workspaceId, user.id, user.role);
  }

  @Post('workspace/:workspaceId/links')
  @ApiOperation({ summary: 'Add a shared link to a workspace' })
  @ApiResponse({ status: 201, description: 'Link created' })
  create(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateSharedLinkDto,
  ) {
    const user = req.user as RequestUser;
    return this.sharedLinkService.create(workspaceId, user.id, user.role, dto);
  }

  @Delete('links/:id')
  @ApiOperation({
    summary: 'Delete a shared link (creator or workspace owner)',
  })
  @ApiResponse({ status: 200, description: 'Link deleted' })
  remove(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as RequestUser;
    return this.sharedLinkService.remove(id, user.id, user.role);
  }
}
