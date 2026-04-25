import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { TimeOffRequestsService } from './time-off-requests.service';
import { CreateTimeOffRequestDto } from './dto/create-time-off-request.dto';
import { ReviewTimeOffRequestDto } from './dto/review-time-off-request.dto';
import { RequestStatus } from '../../database/entities/time-off-request.entity';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, Role } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Employee } from '../../database/entities/employee.entity';

@ApiTags('time-off-requests')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('time-off-requests')
export class TimeOffRequestsController {
  constructor(private readonly service: TimeOffRequestsService) {}

  @Post()
  @ApiOperation({ summary: 'Submit a new time-off request' })
  async submit(@Body() dto: CreateTimeOffRequestDto) {
    return this.service.submit(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List time-off requests with optional filters' })
  @ApiQuery({ name: 'employeeId', required: false })
  @ApiQuery({ name: 'status', required: false, enum: RequestStatus })
  @ApiQuery({ name: 'locationId', required: false })
  async findAll(
    @Query('employeeId') employeeId?: string,
    @Query('status') status?: RequestStatus,
    @Query('locationId') locationId?: string,
  ) {
    return this.service.findAll({ employeeId, status, locationId });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a specific time-off request' })
  @ApiParam({ name: 'id' })
  async findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Patch(':id/approve')
  @Roles(Role.MANAGER, Role.SYSTEM)
  @ApiOperation({ summary: 'Manager approves a pending request' })
  @ApiParam({ name: 'id' })
  async approve(
    @Param('id') id: string,
    @CurrentUser() user: Employee,
    @Body() dto: ReviewTimeOffRequestDto,
  ) {
    return this.service.approve(id, user.id, dto);
  }

  @Patch(':id/reject')
  @Roles(Role.MANAGER, Role.SYSTEM)
  @ApiOperation({ summary: 'Manager rejects a pending request' })
  @ApiParam({ name: 'id' })
  async reject(
    @Param('id') id: string,
    @CurrentUser() user: Employee,
    @Body() dto: ReviewTimeOffRequestDto,
  ) {
    return this.service.reject(id, user.id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Employee cancels a PENDING request' })
  @ApiParam({ name: 'id' })
  async cancel(
    @Param('id') id: string,
    @CurrentUser() user: Employee,
  ) {
    return this.service.cancel(id, user.id);
  }
}
