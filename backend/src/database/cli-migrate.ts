import { loadConfig } from '../config/env.ts';
import {
  inspectMigrationsDetailedReadOnly,
  runMigrations,
  ensureBaselineSystemCatalog,
  seedDemoSyntheticData,
} from './adapter.ts';
import { reprocessAttendanceRange } from '../modules/attendance/processor.ts';

function parseApprovedMigrationsArg(argv: string[]): string[] | undefined {
  const pref = argv.find((a) => a.startsWith('--approved-migrations='));
  if (!pref) return undefined;
  const raw = pref.slice('--approved-migrations='.length).trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const isCheckOnly = process.argv.includes('--check-only');
  const isVerifySchemaOnly = process.argv.includes('--verify-schema');
  const approvedFiles = parseApprovedMigrationsArg(process.argv);

  if (isCheckOnly) {
    const detailed = await inspectMigrationsDetailedReadOnly();
    console.log(JSON.stringify(detailed));
    if (detailed.checksumMismatches.length > 0) {
      process.exit(2);
    }
    process.exit(0);
  }

  if (isVerifySchemaOnly) {
    const detailed = await inspectMigrationsDetailedReadOnly();
    console.log(
      JSON.stringify({
        ok:
          detailed.schemaVerification.ok &&
          detailed.checksumMismatches.length === 0 &&
          detailed.pendingFiles.length === 0,
        appliedVersions: detailed.appliedVersions,
        pendingFiles: detailed.pendingFiles,
        checksumMismatches: detailed.checksumMismatches,
        schemaVerification: detailed.schemaVerification,
      })
    );
    if (
      !detailed.schemaVerification.ok ||
      detailed.checksumMismatches.length > 0 ||
      detailed.pendingFiles.length > 0
    ) {
      process.exit(1);
    }
    process.exit(0);
  }

  const cfg = loadConfig();
  const result = await runMigrations({
    approvedFiles,
    verifyChecksumStrict: true,
    verifySchemaPostApply: true,
    forceRunInProductionCli: true,
  });
  console.log('[db:migrate] Migrations completed:', JSON.stringify(result));
  await ensureBaselineSystemCatalog({ forceRunInProductionCli: true });

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
  const msg = err instanceof Error ? err.message : String(err);
  console.error('[db:migrate] Fatal error:', msg);
  process.exit(1);
});

