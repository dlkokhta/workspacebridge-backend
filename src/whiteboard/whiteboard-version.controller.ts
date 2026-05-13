import {
  Body,
  Controller,
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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WhiteboardVersionService } from './whiteboard-version.service';
import { CreateWhiteboardVersionDto } from './dto/create-whiteboard-version.dto';

type RequestUser = { id: string; role: UserRole };

@ApiTags('whiteboard')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller()
export class WhiteboardVersionController {
  constructor(private readonly versionService: WhiteboardVersionService) {}

  @Get('whiteboards/:boardId/versions')
  @ApiOperation({ summary: 'List versions for a whiteboard' })
  @ApiResponse({ status: 200, description: 'Versions returned' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  list(@Req() req: Request, @Param('boardId') boardId: string) {
    const user = req.user as RequestUser;
    return this.versionService.list(boardId, user.id);
  }

  @Get('whiteboards/:boardId/versions/:versionId')
  @ApiOperation({ summary: 'Get a single version with full state' })
  @ApiResponse({ status: 200, description: 'Version returned' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  @ApiResponse({ status: 404, description: 'Version not found' })
  getOne(
    @Req() req: Request,
    @Param('versionId') versionId: string,
  ) {
    const user = req.user as RequestUser;
    return this.versionService.getById(versionId, user.id);
  }

  @Post('whiteboards/:boardId/versions')
  @ApiOperation({ summary: 'Save a manual snapshot of the board' })
  @ApiResponse({ status: 201, description: 'Version created' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  create(
    @Req() req: Request,
    @Param('boardId') boardId: string,
    @Body() dto: CreateWhiteboardVersionDto,
  ) {
    const user = req.user as RequestUser;
    return this.versionService.create(boardId, user.id, dto);
  }

  @Post('whiteboards/:boardId/versions/:versionId/restore')
  @ApiOperation({
    summary: 'Restore a version (auto-snapshots current state first)',
  })
  @ApiResponse({ status: 200, description: 'Board restored' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  @ApiResponse({ status: 404, description: 'Version not found' })
  restore(
    @Req() req: Request,
    @Param('versionId') versionId: string,
  ) {
    const user = req.user as RequestUser;
    return this.versionService.restore(versionId, user.id);
  }
}
