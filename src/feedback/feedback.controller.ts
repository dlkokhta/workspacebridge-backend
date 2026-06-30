import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { FeedbackService } from './feedback.service';
import { CreateBugReportDto } from './dto/create-bug-report.dto';
import { CreateErrorLogDto } from './dto/create-error-log.dto';
import { UpdateBugReportDto } from './dto/update-bug-report.dto';

type RequestUser = { id: string; role: UserRole };

@ApiTags('feedback')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('feedback')
export class FeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  // --- Submission: any authenticated user (freelancer or client tester) ---

  @Post('bug-report')
  @ApiOperation({ summary: 'Submit a bug report' })
  @ApiResponse({ status: 201, description: 'Bug report stored' })
  submitBugReport(
    @Req() req: Request,
    @Body() dto: CreateBugReportDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    const user = req.user as RequestUser;
    return this.feedbackService.createBugReport(user.id, dto, userAgent);
  }

  @Post('error-log')
  @ApiOperation({ summary: 'Report a captured client-side error' })
  @ApiResponse({ status: 201, description: 'Error logged' })
  submitErrorLog(
    @Req() req: Request,
    @Body() dto: CreateErrorLogDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    const user = req.user as RequestUser;
    return this.feedbackService.createErrorLog(user.id, dto, userAgent);
  }

  // --- Review & triage: admin only ---

  @Get('bug-reports')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'List bug reports (Admin only)' })
  @ApiResponse({ status: 200, description: 'Bug reports' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin role required' })
  listBugReports() {
    return this.feedbackService.listBugReports();
  }

  @Patch('bug-reports/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update a bug report status (Admin only)' })
  @ApiResponse({ status: 200, description: 'Bug report updated' })
  @ApiResponse({ status: 404, description: 'Bug report not found' })
  updateBugReport(@Param('id') id: string, @Body() dto: UpdateBugReportDto) {
    return this.feedbackService.updateBugReportStatus(id, dto.status);
  }

  @Delete('bug-reports/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Delete a bug report (Admin only)' })
  @ApiResponse({ status: 200, description: 'Bug report deleted' })
  @ApiResponse({ status: 404, description: 'Bug report not found' })
  deleteBugReport(@Param('id') id: string) {
    return this.feedbackService.deleteBugReport(id);
  }

  @Get('error-logs')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'List captured client errors (Admin only)' })
  @ApiResponse({ status: 200, description: 'Error logs' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin role required' })
  listErrorLogs() {
    return this.feedbackService.listErrorLogs();
  }

  @Delete('error-logs/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Delete an error log (Admin only)' })
  @ApiResponse({ status: 200, description: 'Error log deleted' })
  @ApiResponse({ status: 404, description: 'Error log not found' })
  deleteErrorLog(@Param('id') id: string) {
    return this.feedbackService.deleteErrorLog(id);
  }
}
