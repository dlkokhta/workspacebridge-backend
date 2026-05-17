import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { FileService } from './file.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

type RequestUser = { id: string; role: UserRole };

@ApiTags('file')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller()
export class FileController {
  constructor(private readonly fileService: FileService) {}

  @Get('workspace/:workspaceId/files')
  @ApiOperation({ summary: 'List files in a workspace' })
  @ApiResponse({ status: 200, description: 'Returns files (id, name, size, mimeType, uploadedBy, createdAt)' })
  list(@Req() req: Request, @Param('workspaceId') workspaceId: string) {
    const user = req.user as RequestUser;
    return this.fileService.list(workspaceId, user.id, user.role);
  }

  @Post('workspace/:workspaceId/files')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a file to a workspace' })
  @ApiResponse({ status: 201, description: 'File uploaded' })
  upload(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const user = req.user as RequestUser;
    return this.fileService.upload({
      workspaceId,
      userId: user.id,
      userRole: user.role,
      file,
    });
  }

  @Get('files/:id/download')
  @ApiOperation({ summary: 'Get a presigned download URL for a file' })
  @ApiResponse({ status: 200, description: 'Returns { url, expiresIn }' })
  download(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as RequestUser;
    return this.fileService.getDownloadUrl(id, user.id, user.role);
  }

  @Delete('files/:id')
  @ApiOperation({ summary: 'Soft-delete a file' })
  @ApiResponse({ status: 200, description: 'File deleted' })
  remove(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as RequestUser;
    return this.fileService.remove(id, user.id, user.role);
  }
}
