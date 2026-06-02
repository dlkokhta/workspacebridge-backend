import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { SearchService } from './search.service';
import { SearchQueryDto } from './dto/search-query.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

type RequestUser = { id: string; role: UserRole };

@ApiTags('search')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller()
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get('search')
  @ApiOperation({
    summary: 'Global search across every workspace the user can access',
  })
  @ApiResponse({
    status: 200,
    description:
      'Ranked, highlighted results grouped by type. Matched runs in each ' +
      'snippet are wrapped in U+0001/U+0002 control characters.',
  })
  searchGlobal(@Req() req: Request, @Query() query: SearchQueryDto) {
    const user = req.user as RequestUser;
    return this.searchService.search({
      userId: user.id,
      role: user.role,
      q: query.q,
      types: query.types,
      limit: query.limit ?? 20,
    });
  }

  @Get('workspace/:workspaceId/search')
  @ApiOperation({ summary: 'Search within a single workspace' })
  @ApiResponse({
    status: 200,
    description: 'Ranked, highlighted results scoped to the workspace.',
  })
  searchWorkspace(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Query() query: SearchQueryDto,
  ) {
    const user = req.user as RequestUser;
    return this.searchService.search({
      userId: user.id,
      role: user.role,
      workspaceId,
      q: query.q,
      types: query.types,
      limit: query.limit ?? 20,
    });
  }
}
