import {
  Controller,
  Delete,
  FileTypeValidator,
  Get,
  MaxFileSizeValidator,
  Param,
  ParseFilePipe,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AvatarService } from './avatar.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

@ApiTags('user')
@Controller()
export class AvatarController {
  constructor(private readonly avatarService: AvatarService) {}

  // Public, no guard: avatars are shown in shared workspaces and the URL is
  // already unguessable enough (random user id + content hash). The `?v=hash`
  // query is ignored server-side; it only busts the immutable cache.
  @ApiOperation({ summary: 'Get a user avatar image (public)' })
  @ApiResponse({ status: 200, description: 'Returns the WebP avatar bytes' })
  @ApiResponse({ status: 404, description: 'No avatar set' })
  @Get('user/:id/avatar')
  async serve(@Param('id') id: string, @Res() res: Response) {
    const avatar = await this.avatarService.getAvatar(id);
    res.setHeader('Content-Type', avatar.contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', `"${avatar.hash}"`);
    // Helmet sets Cross-Origin-Resource-Policy: same-origin globally, which makes
    // the browser fetch this image but refuse to render it when embedded from the
    // frontend origin (different port = cross-origin), showing a broken image.
    // This endpoint is intentionally public and meant to be embedded cross-origin,
    // so opt it out of CORP. Override must come after helmet's middleware (it does).
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(avatar.data);
  }

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload / replace the current user avatar' })
  @ApiResponse({ status: 201, description: 'Returns the new picture URL' })
  @ApiResponse({ status: 400, description: 'Invalid or missing image' })
  @Post('user/me/avatar')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_AVATAR_BYTES } }),
  )
  upload(
    @Req() req: Request,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: MAX_AVATAR_BYTES }),
          // Match the declared mimetype rather than sniffing magic numbers:
          // Nest 11's magic-number path needs file-type v17+ (`fileTypeFromBuffer`),
          // but this project is on file-type v16 (`fromBuffer`), so that path throws
          // and rejects every upload. The content is still validated downstream —
          // sharp re-encodes and throws BadRequest on anything that isn't a real image.
          new FileTypeValidator({
            fileType: /^image\/(png|jpe?g|webp|gif|avif)$/,
            skipMagicNumbersValidation: true,
          }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    return this.avatarService.uploadAvatar((req.user as any).id, file, baseUrl);
  }

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Remove the current user avatar' })
  @ApiResponse({ status: 200, description: 'Avatar removed' })
  @Delete('user/me/avatar')
  remove(@Req() req: Request) {
    return this.avatarService.removeAvatar((req.user as any).id);
  }
}
