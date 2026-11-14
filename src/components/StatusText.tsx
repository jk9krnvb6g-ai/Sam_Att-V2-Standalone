import React from 'react';

export function AttendanceStatusText({
  status,
  secondaryFlags,
}: {
  status: string;
  secondaryFlags?: string | null;
}) {
  const map: Record<string, { label: string; colorClass: string }> = {
    NORMAL: {
      label: 'NORMAL · ลงเวลาปกติ',
      colorClass: 'text-emerald-700 font-semibold',
    },
    LATE: {
      label: 'LATE · มาสาย',
      colorClass: 'text-amber-700 font-semibold',
    },
    NO_SCAN: {
      label: 'NO_SCAN · ไม่พบสแกนหลัง Cutoff',
      colorClass: 'text-red-700 font-semibold',
    },
    MISSING_CHECKOUT: {
      label: 'MISSING_CHECKOUT · ขาดสแกนออก',
      colorClass: 'text-orange-700 font-semibold',
    },
    NO_SCHEDULE: {
      label: 'NO_SCHEDULE · ไม่มีตารางเวร',
      colorClass: 'text-slate-600 font-medium',
    },
    PENDING_MAPPING: {
      label: 'PENDING_MAPPING · รอจับคู่ FINGLE_ID',
      colorClass: 'text-purple-700 font-semibold',
    },
  };

  const info = map[status] || { label: status, colorClass: 'text-slate-700 font-medium' };

  return (
    <div className="flex flex-col">
      <span className={`text-xs ${info.colorClass} whitespace-nowrap`}>{info.label}</span>
      {secondaryFlags && (
        <span className="text-[11px] text-amber-800">หมายเหตุพ่วง: {secondaryFlags}</span>
      )}
    </div>
  );
}

export function RoleLabel({ role }: { role: string }) {
  if (role === 'ADMIN') {
    return <span className="text-xs font-semibold text-teal-800">ADMIN · ผู้ดูแลระบบ</span>;
  }
  if (role === 'RESPONSIBLE_STAFF') {
    return <span className="text-xs font-semibold text-blue-800">RESPONSIBLE_STAFF · เจ้าหน้าที่ผู้รับผิดชอบ</span>;
  }
  return <span className="text-xs font-medium text-slate-700">GENERAL_USER · บุคลากรทั่วไป</span>;
}

export function ErrorBanner({
  error,
  onRetry,
}: {
  error: { code?: string; message: string; failClosed?: boolean } | null;
  onRetry?: () => void;
}) {
  if (!error) return null;

  return (
    <div
      role="alert"
      className="border border-red-300 bg-red-50/90 px-4 py-3 rounded-lg text-sm text-red-900 flex items-start justify-between gap-4"
    >
      <div className="space-y-1">
        <div className="font-semibold flex items-center gap-2">
          <span>แจ้งเตือนข้อผิดพลาดจากระบบ (Fail-Closed)</span>
          {error.code && <span className="font-mono text-xs text-red-700">[{error.code}]</span>}
        </div>
        <p className="text-red-800 leading-relaxed">{error.message}</p>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="px-3 py-1.5 text-xs font-medium bg-white border border-red-300 text-red-800 rounded hover:bg-red-100 transition-colors whitespace-nowrap shrink-0"
        >
          ลองใหม่อีกครั้ง
        </button>
      )}
    </div>
  );
}
