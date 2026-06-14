import {
  Controller,
  Get,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { HealthService } from './health.service';

@ApiTags('health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  // Liveness: the process is up and serving HTTP. Touches no dependencies, so
  // it stays green even while the DB is briefly unreachable — restarting the
  // process wouldn't help there, so a liveness probe must not fail on it.
  @ApiOperation({ summary: 'Liveness probe' })
  @ApiResponse({ status: 200, description: 'The service is running' })
  @Get()
  liveness() {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  // Readiness: the service can actually serve traffic — i.e. its database is
  // reachable. Returns 503 when the DB check fails so an orchestrator / load
  // balancer stops routing requests to this instance.
  @ApiOperation({ summary: 'Readiness probe (checks the database)' })
  @ApiResponse({ status: 200, description: 'The service and its DB are ready' })
  @ApiResponse({ status: 503, description: 'A dependency is unavailable' })
  @Get('ready')
  async readiness() {
    const dbUp = await this.healthService.checkDatabase();
    const body = {
      status: dbUp ? 'ok' : 'error',
      database: dbUp ? 'up' : 'down',
      timestamp: new Date().toISOString(),
    };
    if (!dbUp) throw new ServiceUnavailableException(body);
    return body;
  }
}
