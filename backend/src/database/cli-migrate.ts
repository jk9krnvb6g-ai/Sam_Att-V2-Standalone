import { runMigrations, seedBaselineAndSyntheticData } from './adapter.ts';
import { reprocessAttendanceRange } from '../modules/attendance/processor.ts';

async function main() {
  const result = await runMigrations();
  console.log('[db:migrate] Migrations completed:', JSON.stringify(result));
  await seedBaselineAndSyntheticData();
  const calc = await reprocessAttendanceRange({
    dateFrom: '2026-11-12',
    dateTo: '2026-11-13',
    referenceNowBkk: '2026-11-13 18:00:00',
    actorUsername: 'system_migrate',
  });
  console.log('[db:migrate] Initial attendance calculation:', JSON.stringify(calc));
}

main().catch((err) => {
  console.error('[db:migrate] Fatal error:', err);
  process.exit(1);
});
