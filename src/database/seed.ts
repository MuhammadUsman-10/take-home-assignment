import { DataSource } from 'typeorm';
import { Employee } from './entities/employee.entity';
import { Balance } from './entities/balance.entity';
import { LeaveType } from './entities/leave-type.entity';
import { Location } from './entities/location.entity';

export async function seed(dataSource: DataSource): Promise<void> {
  const employeeRepo = dataSource.getRepository(Employee);
  const balanceRepo = dataSource.getRepository(Balance);
  const leaveTypeRepo = dataSource.getRepository(LeaveType);
  const locationRepo = dataSource.getRepository(Location);

  // Leave Types
  const vacation = leaveTypeRepo.create({ name: 'Vacation', hcmLeaveTypeId: 'VACATION' });
  const sick = leaveTypeRepo.create({ name: 'Sick', hcmLeaveTypeId: 'SICK' });
  const personal = leaveTypeRepo.create({ name: 'Personal', hcmLeaveTypeId: 'PERSONAL' });
  await leaveTypeRepo.save([vacation, sick, personal]);

  // Locations
  const nyc = locationRepo.create({ name: 'New York City', hcmLocationId: 'loc-nyc', timezone: 'America/New_York', country: 'US' });
  const sf = locationRepo.create({ name: 'San Francisco', hcmLocationId: 'loc-sf', timezone: 'America/Los_Angeles', country: 'US' });
  await locationRepo.save([nyc, sf]);

  // Employees
  const alice = await employeeRepo.save({
    name: 'Alice Smith', email: 'alice@company.com',
    hcmEmployeeId: 'emp-001', locationId: 'loc-nyc', role: 'employee',
  });
  const bob = await employeeRepo.save({
    name: 'Bob Jones', email: 'bob@company.com',
    hcmEmployeeId: 'emp-002', locationId: 'loc-sf', role: 'manager',
  });

  // Balances
  await balanceRepo.save([
    { employeeId: alice.id, locationId: 'loc-nyc', leaveTypeId: 'VACATION', totalDays: 15, usedDays: 3, reservedDays: 0 },
    { employeeId: alice.id, locationId: 'loc-nyc', leaveTypeId: 'SICK', totalDays: 10, usedDays: 1, reservedDays: 0 },
    { employeeId: alice.id, locationId: 'loc-nyc', leaveTypeId: 'PERSONAL', totalDays: 3, usedDays: 0, reservedDays: 0 },
    { employeeId: bob.id, locationId: 'loc-sf', leaveTypeId: 'VACATION', totalDays: 20, usedDays: 5, reservedDays: 0 },
    { employeeId: bob.id, locationId: 'loc-sf', leaveTypeId: 'SICK', totalDays: 10, usedDays: 0, reservedDays: 0 },
  ]);

  console.log('✅ Database seeded successfully');
  console.log(`   Alice (${alice.id}): 12 vacation days available`);
  console.log(`   Bob (${bob.id}): 15 vacation days available`);
}
