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
import { PrivateTaskService } from './private-task.service';
import { CreatePrivateTaskDto } from './dto/create-private-task.dto';
import { UpdatePrivateTaskDto } from './dto/update-private-task.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

type RequestUser = { id: string; role: UserRole };

@ApiTags('private-task')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller()
export class PrivateTaskController {
  constructor(private readonly privateTaskService: PrivateTaskService) {}

  @Get('workspace/:workspaceId/private-tasks')
  @ApiOperation({
    summary: 'List private tasks for the current user in a workspace',
  })
  @ApiResponse({ status: 200, description: 'Returns private tasks' })
  list(@Req() req: Request, @Param('workspaceId') workspaceId: string) {
    const user = req.user as RequestUser;
    return this.privateTaskService.list(workspaceId, user.id);
  }

  @Post('workspace/:workspaceId/private-tasks')
  @ApiOperation({ summary: 'Create a private task in a workspace' })
  @ApiResponse({ status: 201, description: 'Private task created' })
  create(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreatePrivateTaskDto,
  ) {
    const user = req.user as RequestUser;
    return this.privateTaskService.create(workspaceId, user.id, dto);
  }

  @Patch('private-tasks/:id')
  @ApiOperation({ summary: 'Update a private task (title or status)' })
  @ApiResponse({ status: 200, description: 'Private task updated' })
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdatePrivateTaskDto,
  ) {
    const user = req.user as RequestUser;
    return this.privateTaskService.update(id, user.id, dto);
  }

  @Delete('private-tasks/:id')
  @ApiOperation({ summary: 'Delete a private task' })
  @ApiResponse({ status: 200, description: 'Private task deleted' })
  remove(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as RequestUser;
    return this.privateTaskService.remove(id, user.id);
  }
}
