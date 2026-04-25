import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { IsString, IsUUID } from 'class-validator';
import { AuthService } from './auth.service';

class GetTokenDto {
  @IsUUID()
  employeeId: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get JWT token for an employee (dev/test convenience endpoint)' })
  async getToken(@Body() dto: GetTokenDto) {
    return this.authService.generateToken(dto.employeeId);
  }
}
