/**
 * ============================================================================
 * CLI สำหรับตรวจสอบความพร้อมของฐานข้อมูลแบบ Read-Only 100% (Database Preflight CLI)
 * ไฟล์: backend/src/database/cli-preflight.ts
 * ============================================================================
 * การเรียกใช้:
 *   npm run db:preflight
 *   node --import tsx backend/src/database/cli-preflight.ts [--json]
 *
 * ความปลอดภัย (Phase 2.3):
 * - ทำงานแบบ Read-Only (SELECT เท่านั้น) ห้ามสร้าง แก้ไข หรือลบตาราง/ข้อมูลใดๆ เด็ดขาด
 * - ปกปิดข้อมูลความลับทุกชนิดในผลลัพธ์
 */
import { runProductionDatabasePreflightReadOnly, closeDatabaseConnections } from './adapter.ts';
import { redactSecretsFromText } from '../utils/logger.ts';

async function main(): Promise<void> {
  const jsonOnly = process.argv.includes('--json');
  try {
    const report = await runProductionDatabasePreflightReadOnly();
    const safeReportJson = redactSecretsFromText(JSON.stringify(report, null, 2));

    if (jsonOnly) {
      console.log(safeReportJson);
    } else {
      console.log('======================================================================');
      console.log(' Sam_Att V2 Standalone — Read-Only Database Preflight Report');
      console.log('======================================================================');
      console.log(`Status            : ${report.ok ? 'PASS (READ-ONLY VERIFIED)' : 'FAIL'}`);
      console.log(`Engine            : ${report.engine}`);
      console.log(`Target Host/Port  : ${report.host}:${report.port}`);
      console.log(`Expected Database : ${report.expectedDatabase}`);
      console.log(`Connected DB      : ${report.connectedDatabase || 'N/A'}`);
      console.log(`Server Version    : ${report.serverVersion || 'N/A'}`);
      console.log(`Charset/Collation : ${report.characterSet || 'N/A'} / ${report.collation || 'N/A'}`);
      console.log(`Timezone          : ${report.timezone || 'N/A'}`);
      console.log(`Existing Tables   : ${report.existingTablesCount} (Required: ${report.requiredTablesExpected.length})`);
      console.log(`Missing Tables    : ${report.missingTables.length === 0 ? 'NONE' : report.missingTables.join(', ')}`);
      console.log(`Missing Columns   : ${report.missingColumns.length === 0 ? 'NONE' : report.missingColumns.join(', ')}`);
      console.log(`Pending Migrations: ${report.pendingMigrations.length === 0 ? 'NONE' : report.pendingMigrations.join(', ')}`);
      if (report.errors.length > 0) {
        console.error('Errors:');
        for (const err of report.errors) {
          console.error(`  - ${redactSecretsFromText(err)}`);
        }
      }
      console.log('======================================================================');
      console.log(`PREFLIGHT_JSON_RESULT:${ redactSecretsFromText(JSON.stringify(report)) }`);
    }

    await closeDatabaseConnections();
    process.exit(report.ok ? 0 : 1);
  } catch (err: unknown) {
    const msg = redactSecretsFromText(err instanceof Error ? err.message : String(err));
    console.error(`[Sam_Att DB Preflight Fatal] ${msg}`);
    await closeDatabaseConnections();
    process.exit(1);
  }
}

main();
