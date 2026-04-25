import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { RolesGuard } from './guards/roles.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { Employee } from '../../database/entities/employee.entity';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.get<string>('app.jwtSecret'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        signOptions: { expiresIn: cfg.get<string>('app.jwtExpiresIn', '24h') as any },
      }),
    }),
    TypeOrmModule.forFeature([Employee]),
  ],
  providers: [AuthService, JwtStrategy, RolesGuard, JwtAuthGuard],
  controllers: [AuthController],
  exports: [AuthService, JwtModule, PassportModule, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
