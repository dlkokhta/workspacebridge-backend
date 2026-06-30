import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { BugReportStatus } from '@prisma/client';

export class UpdateBugReportDto {
  @ApiProperty({ enum: BugReportStatus, example: BugReportStatus.RESOLVED })
  @IsEnum(BugReportStatus)
  status!: BugReportStatus;
}
