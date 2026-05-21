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
import { UserRole } from '@prisma/client';
import { SharedTaskService } from './shared-task.service';
import { CreateSharedTaskDto } from './dto/create-shared-task.dto';
import { UpdateSharedTaskDto } from './dto/update-shared-task.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

type RequestUser = { id: string; role: UserRole };

@ApiTags('shared-task')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller()
export class SharedTaskController {
  constructor(private readonly sharedTaskService: SharedTaskService) {}

  @Get('workspace/:workspaceId/shared-tasks')
  @ApiOperation({ summary: 'List shared tasks in a workspace' })
  @ApiResponse({ status: 200, description: 'Returns shared tasks with createdBy' })
  list(@Req() req: Request, @Param('workspaceId') workspaceId: string) {
    const user = req.user as RequestUser;
    return this.sharedTaskService.list(workspaceId, user.id);
  }

  @Post('workspace/:workspaceId/shared-tasks')
  @ApiOperation({ summary: 'Create a shared task in a workspace' })
  @ApiResponse({ status: 201, description: 'Shared task created' })
  create(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateSharedTaskDto,
  ) {
    const user = req.user as RequestUser;
    return this.sharedTaskService.create(workspaceId, user.id, dto);
  }

  @Patch('shared-tasks/:id')
  @ApiOperation({ summary: 'Update a shared task (title or status)' })
  @ApiResponse({ status: 200, description: 'Shared task updated' })
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateSharedTaskDto,
  ) {
    const user = req.user as RequestUser;
    return this.sharedTaskService.update(id, user.id, dto);
  }

  @Delete('shared-tasks/:id')
  @ApiOperation({ summary: 'Delete a shared task (creator or workspace owner)' })
  @ApiResponse({ status: 200, description: 'Shared task deleted' })
  remove(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as RequestUser;
    return this.sharedTaskService.remove(id, user.id);
  }
}
