/**
 * ============================================================================
 * หน้า: ศูนย์ตรวจสอบสุขภาพระบบ (ADMIN-Only Read-Only Diagnostics Center) (B9)
 * ไฟล์: frontend/src/pages/SystemHealthView.tsx
 * ============================================================================
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Database,
  Radio,
  Layers,
  Server,
  Rocket,
  HardDrive,
  Archive,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import { apiRequest, ApiClientError, type UserRole } from '../services/api.ts';
import { ErrorBanner } from '../components/StatusText.tsx';
import {
  PageHeader,
  MetricStrip,
  StatusBadge,
  TableLoadingSkeleton,
} from '../components/common/SharedComponents.tsx';
import { PageHelpAction } from '../components/common/ContextualHelp.tsx';
import type { NavViewKey } from '../components/layout/Sidebar.tsx';
import { formatThaiDateTime } from '../utils/thaiFormat.ts';

function getHealthBadgeProps(status: string): {
  tone: 'success' | 'warning' | 'danger' | 'neutral';
  label: string;
} {
  const s = String(status || '').toUpperCase();
  if (s === 'HEALTHY') return { tone: 'success', label: 'ปกติ (HEALTHY)' };
  if (s === 'WARNING') return { tone: 'warning', label: 'ต้องตรวจสอบ (WARNING)' };
  if (s === 'CRITICAL') return { tone: 'danger', label: 'วิกฤต (CRITICAL)' };
  if (s === 'NOT_CONFIGURED') return { tone: 'neutral', label: 'ยังไม่ได้ตั้งค่า' };
  return { tone: 'neutral', label: 'ไม่ทราบสถานะ (UNKNOWN)' };
}

function getComponentIcon(key: string) {
  switch (key) {
    case 'backend':
      return Activity;
    case 'database':
      return Database;
    case 'scanner':
      return Radio;
    case 'processingBacklog':
      return Layers;
    case 'hosoffice':
      return Server;
    case 'githubUpdater':
      return Rocket;
    case 'diskSpace':
      return HardDrive;
    case 'backup':
      return Archive;
    default:
      return Activity;
  }
}

export function SystemHealthView({
  userRole,
  onNavigate,
}: {
  userRole?: UserRole;
  onNavigate?: (view: NavViewKey) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [health, setHealth] = useState<any>(null);

  const loadHealth = useCallback(async () => {
    if (userRole !== 'ADMIN') {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest('/system/health-center');
      setHealth(res);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      } else {
        setError({ message: 'ไม่สามารถโหลดข้อมูลสุขภาพระบบได้' });
      }
    } finally {
      setLoading(false);
    }
  }, [userRole]);

  useEffect(() => {
    loadHealth();
  }, [loadHealth]);

  if (userRole !== 'ADMIN') {
    return (
      <div className="his-surface p-8 text-center space-y-2">
        <ShieldAlert className="w-8 h-8 text-[#C74455] mx-auto" />
        <div className="text-[16px] font-bold text-[#292638]">
          หน้านี้สงวนสิทธิ์เฉพาะผู้ดูแลระบบ (ADMIN) เท่านั้น
        </div>
        <p className="text-[13.5px] text-[#777287]">
          บัญชีของท่านไม่มีสิทธิ์เข้าถึงศูนย์ตรวจสอบสุขภาพเซิร์ฟเวอร์และฐานข้อมูล
        </p>
      </div>
    );
  }

  const overallBadge = getHealthBadgeProps(health?.overallStatus || 'UNKNOWN');
  const summary = health?.summary;
  const components: any[] = health?.components || [];

  return (
    <div className="space-y-6">
      <PageHeader
        category="ระบบและผู้ดูแล"
        title="ศูนย์ตรวจสอบสุขภาพระบบ (System Health Center)"
        subtitle="ตรวจสอบสถานะ Backend, MySQL, Scanner, คิวประมวลผล, HOSOffice, GitHub Updater, พื้นที่ดิสก์ และ Backup แบบอ่านอย่างเดียว (ไม่มี Auto-Polling)"
        actions={
          <>
            <PageHelpAction
              guideKey="systemHealth"
              userRole={userRole}
              onNavigate={onNavigate}
            />
            <button
              type="button"
              disabled={loading}
              onClick={loadHealth}
              className="ent-btn-primary"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              <span>ตรวจสอบสุขภาพระบบอีกครั้ง</span>
            </button>
          </>
        }
      />

      <ErrorBanner error={error} onRetry={loadHealth} />

      {health && (
        <section className="his-surface p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="text-[12px] text-[#777287]">สถานะรวมของระบบ (Overall System Health)</div>
            <div className="flex flex-wrap items-center gap-2.5">
              <StatusBadge tone={overallBadge.tone} label={overallBadge.label} />
              <span className="text-[12.5px] font-mono tabular-nums text-[#777287]">
                ตรวจล่าสุด: {formatThaiDateTime(health.checkedAt)}
              </span>
            </div>
          </div>
          <span className="text-[12.5px] font-medium text-[#4E3978] bg-[#F1ECFA] px-3 py-1.5 rounded-lg border border-[#E8E4EF]">
            โหมดอ่านอย่างเดียว (Read-Only Diagnostics)
          </span>
        </section>
      )}

      {summary && (
        <MetricStrip
          columns={5}
          items={[
            {
              id: 'total',
              label: 'รายการตรวจทั้งหมด',
              value: summary.totalChecks,
              unit: 'องค์ประกอบ',
              tone: 'brand',
            },
            {
              id: 'healthy',
              label: 'สถานะปกติ (HEALTHY)',
              value: summary.healthyCount,
              unit: 'รายการ',
              tone: 'success',
            },
            {
              id: 'warning',
              label: 'ต้องตรวจสอบ (WARNING)',
              value: summary.warningCount,
              unit: 'รายการ',
              tone: summary.warningCount > 0 ? 'warning' : 'success',
            },
            {
              id: 'critical',
              label: 'วิกฤต (CRITICAL)',
              value: summary.criticalCount,
              unit: 'รายการ',
              tone: summary.criticalCount > 0 ? 'danger' : 'success',
            },
            {
              id: 'unknown',
              label: 'ไม่ทราบ / ยังไม่ตั้งค่า',
              value: summary.unknownCount + summary.notConfiguredCount,
              unit: 'รายการ',
              tone: 'default',
            },
          ]}
        />
      )}

      {loading ? (
        <div className="his-surface p-6">
          <TableLoadingSkeleton rows={4} cols={3} />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {components.map((comp) => {
            const Icon = getComponentIcon(comp.key);
            const badge = getHealthBadgeProps(comp.status);
            const metricEntries = Object.entries(comp.metrics || {}).filter(
              ([, v]) => v !== null && v !== undefined && typeof v !== 'object'
            );

            return (
              <section key={comp.key} className="his-surface p-5 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-9 h-9 rounded-lg bg-[#F1ECFA] text-[#4E3978] flex items-center justify-center shrink-0">
                      <Icon className="w-4.5 h-4.5" aria-hidden="true" />
                    </div>
                    <h2 className="text-[15px] font-bold text-[#292638] leading-snug">
                      {comp.labelThai}
                    </h2>
                  </div>
                  <StatusBadge tone={badge.tone} label={badge.label} compact />
                </div>

                <p className="text-[13.5px] text-[#292638] leading-relaxed">{comp.detailThai}</p>

                {metricEntries.length > 0 && (
                  <div className="pt-2.5 border-t border-[#E8E4EF] grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
                    {metricEntries.slice(0, 6).map(([k, v]) => (
                      <div key={k} className="flex items-center justify-between gap-2 min-w-0">
                        <span className="text-[#777287] truncate font-mono">{k}</span>
                        <span className="font-mono font-semibold text-[#292638] tabular-nums truncate">
                          {String(v)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
