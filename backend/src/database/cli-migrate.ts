import { loadConfig } from '../config/env.ts';
import { runMigrations, ensureBaselineSystemCatalog, seedDemoSyntheticData } from './adapter.ts';
import { reprocessAttendanceRange } from '../modules/attendance/processor.ts';

async function main() {
  const cfg = loadConfig();
  const result = await runMigrations();
  console.log('[db:migrate] Migrations completed:', JSON.stringify(result));
  await ensureBaselineSystemCatalog();

  if (cfg.dataMode === 'DEMO') {
    await seedDemoSyntheticData();
    const calc = await reprocessAttendanceRange({
      dateFrom: '2026-11-12',
      dateTo: '2026-11-13',
      referenceNowBkk: '2026-11-13 18:00:00',
      actorUsername: 'system_migrate_demo',
    });
    console.log('[db:migrate] DEMO mode synthetic attendance calculation:', JSON.stringify(calc));
  } else {
    console.log('[db:migrate] REAL mode active — baseline system catalog ready without synthetic data.');
  }
}

main().catch((err) => {
  console.error('[db:migrate] Fatal error:', err);
  process.exit(1);
});
