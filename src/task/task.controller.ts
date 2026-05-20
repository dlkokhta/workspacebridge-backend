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
import { TaskService } from './task.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

type RequestUser = { id: string; role: UserRole };

@ApiTags('task')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller()
export class TaskController {
  constructor(private readonly taskService: TaskService) {}

  @Get('workspace/:workspaceId/tasks')
  @ApiOperation({ summary: 'List tasks in a workspace' })
  @ApiResponse({ status: 200, description: 'Returns tasks with createdBy' })
  list(@Req() req: Request, @Param('workspaceId') workspaceId: string) {
    const user = req.user as RequestUser;
    return this.taskService.list(workspaceId, user.id);
  }

  @Post('workspace/:workspaceId/tasks')
  @ApiOperation({ summary: 'Create a task in a workspace' })
  @ApiResponse({ status: 201, description: 'Task created' })
  create(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateTaskDto,
  ) {
    const user = req.user as RequestUser;
    return this.taskService.create(workspaceId, user.id, dto);
  }

  @Patch('tasks/:id')
  @ApiOperation({ summary: 'Update a task (title or status)' })
  @ApiResponse({ status: 200, description: 'Task updated' })
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateTaskDto,
  ) {
    const user = req.user as RequestUser;
    return this.taskService.update(id, user.id, dto);
  }

  @Delete('tasks/:id')
  @ApiOperation({ summary: 'Delete a task (creator or workspace owner)' })
  @ApiResponse({ status: 200, description: 'Task deleted' })
  remove(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as RequestUser;
    return this.taskService.remove(id, user.id);
  }
}
