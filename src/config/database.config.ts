import { registerAs } from '@nestjs/config';
import path from 'path';

export const databaseConfig = registerAs('database', () => ({
  path: process.env.DB_PATH ?? path.resolve(process.cwd(), 'data', 'time-off.db'),
  synchronize: process.env.NODE_ENV === 'test' || process.env.DB_SYNCHRONIZE === 'true',
}));
