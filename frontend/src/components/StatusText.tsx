/**
 * ============================================================================
 * คอมโพเนนต์แสดงสถานะการลงเวลา ระดับสิทธิ์ และกล่องแจ้งเตือนข้อผิดพลาด
 * ไฟล์: frontend/src/components/StatusText.tsx
 * ============================================================================
 * หลักการออกแบบ:
 * - ใช้สีตามความหมายร่วมกับไอคอนและข้อความภาษาไทยชัดเจน (ไม่ใช้สีเพียงอย่างเดียว)
 * - ใช้สีจาก Design System กลาง (Success #198568, Warning #B87516, Danger #C74455, Info #5879BC, Primary Dark #543B7A)
 */
import React from 'react';
import {
  AlertTriangle,
  RotateCw,
  CheckCircle2,
  Clock,
  AlertCircle,
  CalendarOff,
  Link2Off,
  ShieldCheck,
  UserCheck,
  User,
} from 'lucide-react';

export function AttendanceStatusText({
  status,
  secondaryFlags,
  earlyCheckoutMinutes,
}: {
  status: string;
  secondaryFlags?: string | null;
  earlyCheckoutMinutes?: number | null;
}) {
  const map: Record<
    string,
    {
      thaiLabel: string;
      icon: React.ComponentType<{ className?: string }>;
      iconColor: string;
      textColor: string;
    }
  > = {
    NORMAL: {
      thaiLabel: 'ลงเวลาปกติ',
      icon: CheckCircle2,
      iconColor: 'text-[#198568]',
      textColor: 'text-[#198568] font-semibold',
    },
    COMPLETE: {
      thaiLabel: 'ลงเวลาครบเข้า–ออก',
      icon: CheckCircle2,
      iconColor: 'text-[#198568]',
      textColor: 'text-[#198568] font-semibold',
    },
    LATE: {
      thaiLabel: 'มาสาย',
      icon: Clock,
      iconColor: 'text-[#B87516]',
      textColor: 'text-[#B87516] font-semibold',
    },
    NO_SCAN: {
      thaiLabel: 'ไม่พบข้อมูลสแกน',
      icon: AlertCircle,
      iconColor: 'text-[#C74455]',
      textColor: 'text-[#C74455] font-semibold',
    },
    MISSING_CHECKIN: {
      thaiLabel: 'ไม่สแกนเข้างาน',
      icon: AlertTriangle,
      iconColor: 'text-[#C74455]',
      textColor: 'text-[#C74455] font-semibold',
    },
    MISSING_CHECKOUT: {
      thaiLabel: 'ไม่สแกนออกงาน',
      icon: AlertTriangle,
      iconColor: 'text-[#B87516]',
      textColor: 'text-[#B87516] font-semibold',
    },
    NO_SCHEDULE: {
      thaiLabel: 'ไม่มีตารางเวร',
      icon: CalendarOff,
      iconColor: 'text-[#746B83]',
      textColor: 'text-[#746B83] font-medium',
    },
    PENDING_MAPPING: {
      thaiLabel: 'รอเชื่อมโยงรหัสสแกน',
      icon: Link2Off,
      iconColor: 'text-[#5879BC]',
      textColor: 'text-[#5879BC] font-semibold',
    },
  };

  const info = map[status] || {
    thaiLabel: status,
    icon: Clock,
    iconColor: 'text-[#746B83]',
    textColor: 'text-[#262238] font-medium',
  };

  const Icon = info.icon;
  const earlyMin = Number(earlyCheckoutMinutes || 0);

  const secondaryFlagThai =
    secondaryFlags === 'LATE_AND_MISSING_CHECKOUT'
      ? 'เข้างานสายร่วมกับไม่สแกนออก'
      : secondaryFlags === 'LATE_AND_EARLY_CHECKOUT'
      ? earlyMin > 0
        ? `เข้าสายและออกก่อนเวลา ${earlyMin} นาที`
        : 'เข้าสายและออกก่อนเวลา'
      : secondaryFlags === 'EARLY_CHECKOUT'
      ? earlyMin > 0
        ? `ออกก่อนเวลา ${earlyMin} นาที`
        : 'ออกก่อนเวลา'
      : secondaryFlags === 'EMPTY_FINGLE_ID'
      ? 'ยังไม่มีรหัสลายนิ้วมือในระบบ'
      : secondaryFlags === 'DUPLICATE_FINGLE_ID'
      ? 'พบรหัสลายนิ้วมือซ้ำซ้อน'
      : secondaryFlags;

  return (
    <div className="flex flex-col gap-0.5">
      <div className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <Icon className={`w-4 h-4 shrink-0 ${info.iconColor}`} aria-hidden="true" />
        <span className={`text-[13.5px] leading-snug ${info.textColor}`}>{info.thaiLabel}</span>
      </div>
      {secondaryFlagThai && (
        <span className="text-[12px] text-[#B87516] pl-5.5 leading-snug">
          {secondaryFlagThai}
        </span>
      )}
    </div>
  );
}

export function ReviewStatusLabel({ status }: { status: string }) {
  if (status === 'VERIFIED_APPROVED' || status === 'REVIEWED') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[#198568] whitespace-nowrap">
        <CheckCircle2 className="w-4 h-4 shrink-0 text-[#198568]" aria-hidden="true" />
        <span>ตรวจสอบแล้ว</span>
      </span>
    );
  }
  if (status === 'NEEDS_RE_REVIEW') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[#C74455] whitespace-nowrap">
        <AlertTriangle className="w-4 h-4 shrink-0 text-[#C74455]" aria-hidden="true" />
        <span>ต้องตรวจสอบซ้ำ</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[#746B83] whitespace-nowrap">
      <Clock className="w-3.5 h-3.5 shrink-0 text-[#746B83]" aria-hidden="true" />
      <span>รอตรวจสอบ</span>
    </span>
  );
}

export function RoleLabel({ role }: { role: string }) {
  if (role === 'ADMIN') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[#543B7A] whitespace-nowrap">
        <ShieldCheck className="w-4 h-4 text-[#8E70C9] shrink-0" aria-hidden="true" />
        <span>ผู้ดูแลระบบ</span>
      </span>
    );
  }
  if (role === 'RESPONSIBLE_STAFF') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[#5879BC] whitespace-nowrap">
        <UserCheck className="w-4 h-4 text-[#5879BC] shrink-0" aria-hidden="true" />
        <span>เจ้าหน้าที่งานบุคคล (HR)</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[#746B83] whitespace-nowrap">
      <User className="w-4 h-4 text-[#746B83] shrink-0" aria-hidden="true" />
      <span>บุคลากรทั่วไป</span>
    </span>
  );
}

export function ErrorBanner({
  error,
  onRetry,
}: {
  error: { code?: string; message: string; requestId?: string; failClosed?: boolean } | null;
  onRetry?: () => void;
}) {
  if (!error) return null;

  return (
    <div
      role="alert"
      className="border border-[#C74455]/30 bg-[#FDF2F4] px-4 sm:px-5 py-3.5 rounded-xl text-[13.5px] text-[#262238] flex flex-col sm:flex-row sm:items-center justify-between gap-3.5"
    >
      <div className="flex items-start gap-3 min-w-0">
        <AlertTriangle className="w-5 h-5 text-[#C74455] shrink-0 mt-0.5" aria-hidden="true" />
        <div className="space-y-1 min-w-0">
          <div className="font-semibold flex flex-wrap items-center gap-2 text-[14px] text-[#C74455]">
            <span>ไม่สามารถดำเนินการได้</span>
            {error.code && (
              <span className="font-mono text-[12px] text-[#746B83] font-medium">
                · รหัส: {error.code}
              </span>
            )}
            {error.requestId && (
              <span className="font-mono text-[12px] text-[#746B83] font-medium">
                · Ref: {error.requestId}
              </span>
            )}
          </div>
          <p className="text-[#262238] leading-relaxed">{error.message}</p>
        </div>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="h-9 px-3.5 text-[13px] font-semibold bg-white border border-[#C74455]/35 text-[#C74455] rounded-lg hover:bg-[#C74455]/5 transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
        >
          <RotateCw className="w-3.5 h-3.5" />
          <span>ลองใหม่อีกครั้ง</span>
        </button>
      )}
    </div>
  );
}
