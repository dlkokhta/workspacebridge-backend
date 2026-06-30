import { Injectable, NotFoundException } from '@nestjs/common';
import { BugReportStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBugReportDto } from './dto/create-bug-report.dto';
import { CreateErrorLogDto } from './dto/create-error-log.dto';

// Reporter/user fields surfaced to the admin views — never the password hash.
const reporterSelect = {
  select: { id: true, firstname: true, lastname: true, email: true },
} as const;

@Injectable()
export class FeedbackService {
  constructor(private readonly prismaService: PrismaService) {}

  public async createBugReport(
    reporterId: string,
    dto: CreateBugReportDto,
    userAgent?: string,
  ) {
    // Denormalise the reporter's email so the report survives account deletion.
    const reporter = await this.prismaService.user.findUnique({
      where: { id: reporterId },
      select: { email: true },
    });

    return this.prismaService.bugReport.create({
      data: {
        description: dto.description,
        severity: dto.severity,
        url: dto.url,
        lastError: dto.lastError,
        userAgent,
        reporterId,
        reporterEmail: reporter?.email,
      },
    });
  }

  public async createErrorLog(
    userId: string,
    dto: CreateErrorLogDto,
    userAgent?: string,
  ) {
    return this.prismaService.errorLog.create({
      data: {
        message: dto.message,
        source: dto.source,
        stack: dto.stack,
        url: dto.url,
        componentStack: dto.componentStack,
        userAgent,
        userId,
      },
      select: { id: true },
    });
  }

  public async listBugReports() {
    return this.prismaService.bugReport.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { reporter: reporterSelect },
    });
  }

  public async updateBugReportStatus(id: string, status: BugReportStatus) {
    const report = await this.prismaService.bugReport.findUnique({
      where: { id },
    });
    if (!report) throw new NotFoundException('Bug report not found');

    return this.prismaService.bugReport.update({
      where: { id },
      data: { status },
      include: { reporter: reporterSelect },
    });
  }

  public async deleteBugReport(id: string) {
    const report = await this.prismaService.bugReport.findUnique({
      where: { id },
    });
    if (!report) throw new NotFoundException('Bug report not found');

    await this.prismaService.bugReport.delete({ where: { id } });
    return { id };
  }

  public async listErrorLogs() {
    return this.prismaService.errorLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { user: reporterSelect },
    });
  }

  public async deleteErrorLog(id: string) {
    const log = await this.prismaService.errorLog.findUnique({ where: { id } });
    if (!log) throw new NotFoundException('Error log not found');

    await this.prismaService.errorLog.delete({ where: { id } });
    return { id };
  }
}
