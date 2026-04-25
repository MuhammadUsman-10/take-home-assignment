import { SetMetadata } from '@nestjs/common';

export enum Role {
  EMPLOYEE = 'employee',
  MANAGER = 'manager',
  SYSTEM = 'system',
}

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
