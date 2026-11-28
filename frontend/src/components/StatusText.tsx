/**
 * ============================================================================
 * คอมโพเนนต์แสดงสถานะการลงเวลา ระดับสิทธิ์ และกล่องแจ้งเตือนข้อผิดพลาด
 * ไฟล์: frontend/src/components/StatusText.tsx
 * ============================================================================
 * หลักการออกแบบ:
 * - ใช้สีตามความหมายร่วมกับไอคอนและข้อความภาษาไทยชัดเจน (ไม่ใช้สีเพียงอย่างเดียว)
 * - ใช้สีจาก Design System กลาง (#8066B5, #4E3978, #292638, #777287, #198568, #B87516, #C74455, #5879BC)
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
  PlayCircle,
  Briefcase,
  FileCheck2,
  Hourglass,
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
      badgeClass: string;
      iconColor: string;
    }
  > = {
    NORMAL: {
      thaiLabel: 'ลงเวลาปกติ',
      icon: CheckCircle2,
      badgeClass: 'bg-[#EEF8F4] text-[#198568] border-[#198568]/20',
      iconColor: 'text-[#198568]',
    },
    COMPLETE: {
      thaiLabel: 'ลงเวลาครบเข้า–ออก',
      icon: CheckCircle2,
      badgeClass: 'bg-[#EEF8F4] text-[#198568] border-[#198568]/20',
      iconColor: 'text-[#198568]',
    },
    NOT_STARTED: {
      thaiLabel: 'ยังไม่ถึงเวลาเข้างาน',
      icon: Hourglass,
      badgeClass: 'bg-[#F8F7FC] text-[#777287] border-[#E8E4EF]',
      iconColor: 'text-[#777287]',
    },
    AWAITING_CHECKIN: {
      thaiLabel: 'รอสแกนเข้างาน',
      icon: Clock,
      badgeClass: 'bg-[#EFF4FB] text-[#5879BC] border-[#5879BC]/25',
      iconColor: 'text-[#5879BC]',
    },
    IN_PROGRESS: {
      thaiLabel: 'กำลังปฏิบัติงาน',
      icon: PlayCircle,
      badgeClass: 'bg-[#EEF8F4] text-[#198568] border-[#198568]/25',
      iconColor: 'text-[#198568]',
    },
    LATE_IN_PROGRESS: {
      thaiLabel: 'เข้าสาย (กำลังปฏิบัติงาน)',
      icon: PlayCircle,
      badgeClass: 'bg-[#FEF7EA] text-[#B87516] border-[#B87516]/25',
      iconColor: 'text-[#B87516]',
    },
    LATE: {
      thaiLabel: 'มาสาย',
      icon: Clock,
      badgeClass: 'bg-[#FEF7EA] text-[#B87516] border-[#B87516]/25',
      iconColor: 'text-[#B87516]',
    },
    NO_SCAN: {
      thaiLabel: 'ไม่พบข้อมูลสแกน',
      icon: AlertCircle,
      badgeClass: 'bg-[#FDF2F4] text-[#C74455] border-[#C74455]/25',
      iconColor: 'text-[#C74455]',
    },
    MISSING_CHECKIN: {
      thaiLabel: 'ไม่สแกนเข้างาน',
      icon: AlertTriangle,
      badgeClass: 'bg-[#FDF2F4] text-[#C74455] border-[#C74455]/25',
      iconColor: 'text-[#C74455]',
    },
    MISSING_CHECKOUT: {
      thaiLabel: 'ไม่สแกนออกงาน',
      icon: AlertTriangle,
      badgeClass: 'bg-[#FEF7EA] text-[#B87516] border-[#B87516]/25',
      iconColor: 'text-[#B87516]',
    },
    OFF_DAY: {
      thaiLabel: 'วันหยุด / นอกวันทำการ',
      icon: CalendarOff,
      badgeClass: 'bg-[#F1ECFA] text-[#4E3978] border-[#8066B5]/25',
      iconColor: 'text-[#4E3978]',
    },
    APPROVED_LEAVE: {
      thaiLabel: 'ลางานที่อนุมัติแล้ว',
      icon: FileCheck2,
      badgeClass: 'bg-[#EFF4FB] text-[#5879BC] border-[#5879BC]/25',
      iconColor: 'text-[#5879BC]',
    },
    OFFICIAL_DUTY: {
      thaiLabel: 'ไปราชการ',
      icon: Briefcase,
      badgeClass: 'bg-[#EFF4FB] text-[#5879BC] border-[#5879BC]/25',
      iconColor: 'text-[#5879BC]',
    },
    NO_SHIFT: {
      thaiLabel: 'ไม่มีตารางเวร',
      icon: CalendarOff,
      badgeClass: 'bg-[#F8F7FC] text-[#777287] border-[#E8E4EF]',
      iconColor: 'text-[#777287]',
    },
    NO_SCHEDULE: {
      thaiLabel: 'ไม่มีตารางเวร',
      icon: CalendarOff,
      badgeClass: 'bg-[#F8F7FC] text-[#777287] border-[#E8E4EF]',
      iconColor: 'text-[#777287]',
    },
    PENDING_MAPPING: {
      thaiLabel: 'รอเชื่อมโยงรหัสสแกน',
      icon: Link2Off,
      badgeClass: 'bg-[#EFF4FB] text-[#5879BC] border-[#5879BC]/25',
      iconColor: 'text-[#5879BC]',
    },
  };

  const info = map[status] || {
    thaiLabel: status,
    icon: Clock,
    badgeClass: 'bg-[#F8F7FC] text-[#292638] border-[#E8E4EF]',
    iconColor: 'text-[#777287]',
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
    <div className="flex flex-col items-start gap-1">
      <span
        className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md border text-[12.5px] font-semibold whitespace-nowrap ${info.badgeClass}`}
      >
        <Icon className={`w-3.5 h-3.5 shrink-0 ${info.iconColor}`} aria-hidden="true" />
        <span>{info.thaiLabel}</span>
      </span>
      {secondaryFlagThai && (
        <span className="text-[12px] text-[#B87516] leading-snug">
          {secondaryFlagThai}
        </span>
      )}
    </div>
  );
}

export function ReviewStatusLabel({ status }: { status: string }) {
  if (status === 'VERIFIED_APPROVED' || status === 'REVIEWED') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[#EEF8F4] border border-[#198568]/20 text-[12.5px] font-semibold text-[#198568] whitespace-nowrap">
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-[#198568]" aria-hidden="true" />
        <span>ตรวจสอบแล้ว</span>
      </span>
    );
  }
  if (status === 'NEEDS_RE_REVIEW') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[#FDF2F4] border border-[#C74455]/20 text-[12.5px] font-semibold text-[#C74455] whitespace-nowrap">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-[#C74455]" aria-hidden="true" />
        <span>ต้องตรวจสอบซ้ำ</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[#F8F7FC] border border-[#E8E4EF] text-[12.5px] font-medium text-[#777287] whitespace-nowrap">
      <Clock className="w-3.5 h-3.5 shrink-0 text-[#777287]" aria-hidden="true" />
      <span>รอตรวจสอบ</span>
    </span>
  );
}

export function RoleLabel({ role }: { role: string }) {
  if (role === 'ADMIN') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[#4E3978] whitespace-nowrap">
        <ShieldCheck className="w-4 h-4 text-[#8066B5] shrink-0" aria-hidden="true" />
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
    <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[#777287] whitespace-nowrap">
      <User className="w-4 h-4 text-[#777287] shrink-0" aria-hidden="true" />
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
      className="border border-[#C74455]/25 bg-[#FDF2F4] px-4 sm:px-5 py-3.5 rounded-xl text-[13.5px] text-[#292638] flex flex-col sm:flex-row sm:items-center justify-between gap-3.5"
    >
      <div className="flex items-start gap-3 min-w-0">
        <AlertTriangle className="w-5 h-5 text-[#C74455] shrink-0 mt-0.5" aria-hidden="true" />
        <div className="space-y-1 min-w-0">
          <div className="font-semibold flex flex-wrap items-center gap-2 text-[14px] text-[#C74455]">
            <span>ไม่สามารถดำเนินการได้</span>
            {error.code && (
              <span className="font-mono text-[12px] text-[#777287] font-medium">
                · รหัส: {error.code}
              </span>
            )}
            {error.requestId && (
              <span className="font-mono text-[12px] text-[#777287] font-medium">
                · Ref: {error.requestId}
              </span>
            )}
          </div>
          <p className="text-[#292638] leading-relaxed">{error.message}</p>
        </div>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="h-9 px-3.5 text-[13px] font-semibold bg-white border border-[#C74455]/30 text-[#C74455] rounded-lg hover:bg-[#C74455]/5 transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
        >
          <RotateCw className="w-3.5 h-3.5" />
          <span>ลองใหม่อีกครั้ง</span>
        </button>
      )}
    </div>
  );
}
