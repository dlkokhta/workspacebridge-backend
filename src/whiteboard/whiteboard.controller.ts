import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('whiteboard')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('workspace/:workspaceId/whiteboard')
export class WhiteboardController {
  constructor(private readonly whiteboardService: WhiteboardService) {}

  @Get()
  @ApiOperation({ summary: 'Get the whiteboard snapshot for a workspace' })
  @ApiResponse({ status: 200, description: 'Returns the whiteboard' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  @ApiResponse({ status: 404, description: 'Workspace not found' })
  get(@Req() req: Request, @Param('workspaceId') workspaceId: string) {
    const user = req.user as {
      id: string;
      role: 'FREELANCER' | 'CLIENT' | 'ADMIN';
    };
    return this.whiteboardService.getOrCreate(workspaceId, user.id, user.role);
  }

  @Patch()
  @ApiOperation({ summary: 'Save a whiteboard snapshot for a workspace' })
  @ApiResponse({ status: 200, description: 'Whiteboard saved' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  @ApiResponse({ status: 404, description: 'Workspace not found' })
  save(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Body() dto: SaveWhiteboardDto,
  ) {
    const user = req.user as {
      id: string;
      role: 'FREELANCER' | 'CLIENT' | 'ADMIN';
    };
    return this.whiteboardService.save(workspaceId, user.id, user.role, dto);
  }
}
