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
import { FileCommentService } from './file-comment.service';
import { CreateFileCommentDto } from './dto/create-file-comment.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

type RequestUser = { id: string; role: UserRole };

@ApiTags('file-comment')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller()
export class FileCommentController {
  constructor(private readonly fileCommentService: FileCommentService) {}

  @Get('files/:fileId/comments')
  @ApiOperation({ summary: 'List comments on a file' })
  @ApiResponse({ status: 200, description: 'Returns comments with author' })
  list(@Req() req: Request, @Param('fileId') fileId: string) {
    const user = req.user as RequestUser;
    return this.fileCommentService.list(fileId, user.id);
  }

  @Post('files/:fileId/comments')
  @ApiOperation({ summary: 'Add a comment to a file' })
  @ApiResponse({ status: 201, description: 'Comment created' })
  create(
    @Req() req: Request,
    @Param('fileId') fileId: string,
    @Body() dto: CreateFileCommentDto,
  ) {
    const user = req.user as RequestUser;
    return this.fileCommentService.create(fileId, user.id, dto);
  }

  @Delete('file-comments/:id')
  @ApiOperation({
    summary: 'Delete a file comment (author or workspace owner)',
  })
  @ApiResponse({ status: 200, description: 'Comment deleted' })
  remove(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as RequestUser;
    return this.fileCommentService.delete(id, user.id);
  }
}
