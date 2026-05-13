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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WhiteboardCommentService } from './whiteboard-comment.service';
import { CreateWhiteboardCommentDto } from './dto/create-whiteboard-comment.dto';

type RequestUser = { id: string; role: UserRole };

@ApiTags('whiteboard')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller()
export class WhiteboardCommentController {
  constructor(private readonly commentService: WhiteboardCommentService) {}

  @Get('whiteboards/:boardId/comments')
  @ApiOperation({ summary: 'List shape comments for a whiteboard' })
  @ApiResponse({ status: 200, description: 'Comments returned' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  list(@Req() req: Request, @Param('boardId') boardId: string) {
    const user = req.user as RequestUser;
    return this.commentService.list(boardId, user.id);
  }

  @Post('whiteboards/:boardId/comments')
  @ApiOperation({ summary: 'Add a comment on a shape' })
  @ApiResponse({ status: 201, description: 'Comment created' })
  @ApiResponse({ status: 400, description: 'Invalid body' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  create(
    @Req() req: Request,
    @Param('boardId') boardId: string,
    @Body() dto: CreateWhiteboardCommentDto,
  ) {
    const user = req.user as RequestUser;
    return this.commentService.create(boardId, user.id, dto);
  }

  @Delete('whiteboards/:boardId/comments/:commentId')
  @ApiOperation({ summary: 'Delete own comment' })
  @ApiResponse({ status: 200, description: 'Comment deleted' })
  @ApiResponse({ status: 403, description: 'Only the author can delete' })
  @ApiResponse({ status: 404, description: 'Comment not found' })
  remove(@Req() req: Request, @Param('commentId') commentId: string) {
    const user = req.user as RequestUser;
    return this.commentService.delete(commentId, user.id);
  }
}
