import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
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
import { WhiteboardService } from './whiteboard.service';
import { SaveWhiteboardDto } from './dto/save-whiteboard.dto';
import { CreateWhiteboardDto } from './dto/create-whiteboard.dto';
import { RenameWhiteboardDto } from './dto/rename-whiteboard.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UserRole } from '@prisma/client';

type RequestUser = { id: string; role: UserRole };

@ApiTags('whiteboard')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller()
export class WhiteboardController {
  constructor(private readonly whiteboardService: WhiteboardService) {}

  @Get('workspace/:workspaceId/whiteboards')
  @ApiOperation({ summary: 'List whiteboards for a workspace' })
  @ApiResponse({
    status: 200,
    description: 'Returns boards (id, name, updatedAt)',
  })
  list(@Req() req: Request, @Param('workspaceId') workspaceId: string) {
    const user = req.user as RequestUser;
    return this.whiteboardService.list(workspaceId, user.id, user.role);
  }

  @Post('workspace/:workspaceId/whiteboards')
  @ApiOperation({ summary: 'Create a new whiteboard in a workspace' })
  @ApiResponse({ status: 201, description: 'Whiteboard created' })
  create(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateWhiteboardDto,
  ) {
    const user = req.user as RequestUser;
    return this.whiteboardService.create(workspaceId, user.id, user.role, dto);
  }

  @Get('whiteboards/:boardId')
  @ApiOperation({ summary: 'Get a whiteboard snapshot by id' })
  @ApiResponse({ status: 200, description: 'Returns the whiteboard' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  @ApiResponse({ status: 404, description: 'Whiteboard not found' })
  getOne(@Req() req: Request, @Param('boardId') boardId: string) {
    const user = req.user as RequestUser;
    return this.whiteboardService.getById(boardId, user.id);
  }

  @Patch('whiteboards/:boardId')
  @ApiOperation({ summary: 'Save a whiteboard snapshot' })
  @ApiResponse({ status: 200, description: 'Whiteboard saved' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  save(
    @Req() req: Request,
    @Param('boardId') boardId: string,
    @Body() dto: SaveWhiteboardDto,
  ) {
    const user = req.user as RequestUser;
    return this.whiteboardService.save(boardId, user.id, dto);
  }

  @Patch('whiteboards/:boardId/rename')
  @ApiOperation({ summary: 'Rename a whiteboard' })
  @ApiResponse({ status: 200, description: 'Whiteboard renamed' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  @ApiResponse({ status: 404, description: 'Whiteboard not found' })
  rename(
    @Req() req: Request,
    @Param('boardId') boardId: string,
    @Body() dto: RenameWhiteboardDto,
  ) {
    const user = req.user as RequestUser;
    return this.whiteboardService.rename(boardId, user.id, dto);
  }

  @Delete('whiteboards/:boardId')
  @ApiOperation({ summary: 'Delete a whiteboard (workspace owner only)' })
  @ApiResponse({ status: 200, description: 'Whiteboard deleted' })
  @ApiResponse({ status: 403, description: 'Only the workspace owner can delete' })
  @ApiResponse({ status: 404, description: 'Whiteboard not found' })
  remove(@Req() req: Request, @Param('boardId') boardId: string) {
    const user = req.user as RequestUser;
    return this.whiteboardService.delete(boardId, user.id);
  }
}
