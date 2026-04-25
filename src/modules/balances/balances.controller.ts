import {
  Controller, Get, Post, Body, Param, Query, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import {
  ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags,
} from '@nestjs/swagger';
import { BalancesService } from './balances.service';
import { BatchSyncDto } from './dto/batch-sync.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, Role } from '../../common/decorators/roles.decorator';

@ApiTags('balances')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('balances')
export class BalancesController {
  constructor(private readonly balancesService: BalancesService) {}

  @Get(':employeeId/:locationId/:leaveTypeId')
  @ApiOperation({ summary: 'Get balance for employee/location/leaveType' })
  @ApiParam({ name: 'employeeId' })
  @ApiParam({ name: 'locationId' })
  @ApiParam({ name: 'leaveTypeId' })
  @ApiQuery({ name: 'refresh', required: false, type: Boolean })
  async getBalance(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
    @Param('leaveTypeId') leaveTypeId: string,
    @Query('refresh') refresh?: boolean,
  ) {
    return this.balancesService.getBalance(employeeId, locationId, leaveTypeId, refresh);
  }

  @Get(':employeeId')
  @ApiOperation({ summary: 'Get all balances for an employee' })
  async getAllForEmployee(@Param('employeeId') employeeId: string) {
    return this.balancesService.getAllBalancesForEmployee(employeeId);
  }

  @Post('sync/batch')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.SYSTEM, Role.MANAGER)
  @ApiOperation({ summary: 'Ingest full HCM batch balance snapshot (HCM always wins)' })
  async batchSync(@Body() dto: BatchSyncDto) {
    return this.balancesService.processBatchSync(dto);
  }

  @Post('sync/realtime/:employeeId/:locationId/:leaveTypeId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Force real-time pull from HCM for a specific employee/location/leaveType' })
  async realtimeSync(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
    @Param('leaveTypeId') leaveTypeId: string,
  ) {
    return this.balancesService.syncRealtimeFromHcm(employeeId, locationId, leaveTypeId);
  }
}
