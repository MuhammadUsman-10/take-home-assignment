import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Employee } from '../../database/entities/employee.entity';

export interface JwtPayload {
  sub: string;       // employee ID
  email: string;
  role: string;
  hcmEmployeeId: string;
  locationId: string;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(Employee)
    private readonly employeeRepo: Repository<Employee>,
    private readonly jwtService: JwtService,
  ) {}

  async generateToken(employeeId: string): Promise<{ accessToken: string; employee: Employee }> {
    const employee = await this.employeeRepo.findOne({ where: { id: employeeId } });
    if (!employee) throw new UnauthorizedException('Employee not found');

    const payload: JwtPayload = {
      sub: employee.id,
      email: employee.email,
      role: employee.role,
      hcmEmployeeId: employee.hcmEmployeeId,
      locationId: employee.locationId,
    };

    return {
      accessToken: this.jwtService.sign(payload),
      employee,
    };
  }

  async validatePayload(payload: JwtPayload): Promise<Employee> {
    const employee = await this.employeeRepo.findOne({ where: { id: payload.sub } });
    if (!employee) throw new UnauthorizedException('Token invalid');
    return employee;
  }
}
