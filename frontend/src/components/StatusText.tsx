/**
 * ============================================================================
 * คอมโพเนนต์แสดงป้ายสถานะการลงเวลา ระดับสิทธิ์ และกล่องแจ้งเตือนข้อผิดพลาด
 * ไฟล์: frontend/src/components/StatusText.tsx
 * ============================================================================
 * หน้าที่หลัก:
 * 1. AttendanceStatusText: แสดงไอคอนและข้อความสถานะการลงเวลาภาษาไทยตามสีมาตรฐาน
 *    - NORMAL (สีเขียว): ลงเวลาปกติ
 *    - LATE (สีเหลืองอำพัน): มาสาย
 *    - NO_SCAN (สีแดง): ไม่พบข้อมูลสแกน
 *    - MISSING_CHECKOUT (สีส้มอำพัน): ไม่สแกนออกงาน
 *    - PENDING_MAPPING (สีน้ำเงิน): รอเชื่อมโยงรหัสสแกน
 * 2. ReviewStatusLabel: แสดงสถานะการตรวจสอบโดยเจ้าหน้าที่งานบุคคล (ตรวจสอบแล้ว / รอตรวจสอบ)
 * 3. RoleLabel: แสดงชื่อระดับสิทธิ์ผู้ใช้งานเป็นภาษาไทย (ผู้ดูแลระบบ / เจ้าหน้าที่งานบุคคล / บุคลากรทั่วไป)
 * 4. ErrorBanner: กล่องแจ้งเตือนข้อผิดพลาดพร้อมปุ่มลองใหม่อีกครั้ง
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

/**
 * แสดงสถานะการลงเวลารายกะพร้อมไอคอนสื่อความหมายและข้อความหมายเหตุประกอบ
 */
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
      iconColor: 'text-[#047857]',
      textColor: 'text-[#047857] font-semibold',
    },
    COMPLETE: {
      thaiLabel: 'ลงเวลาครบเข้า–ออก',
      icon: CheckCircle2,
      iconColor: 'text-[#047857]',
      textColor: 'text-[#047857] font-semibold',
    },
    LATE: {
      thaiLabel: 'มาสาย',
      icon: Clock,
      iconColor: 'text-[#B45309]',
      textColor: 'text-[#B45309] font-semibold',
    },
    NO_SCAN: {
      thaiLabel: 'ไม่พบข้อมูลสแกน',
      icon: AlertCircle,
      iconColor: 'text-[#B91C1C]',
      textColor: 'text-[#B91C1C] font-semibold',
    },
    MISSING_CHECKIN: {
      thaiLabel: 'ไม่สแกนเข้างาน',
      icon: AlertTriangle,
      iconColor: 'text-[#B91C1C]',
      textColor: 'text-[#B91C1C] font-semibold',
    },
    MISSING_CHECKOUT: {
      thaiLabel: 'ไม่สแกนออกงาน',
      icon: AlertTriangle,
      iconColor: 'text-[#B45309]',
      textColor: 'text-[#B45309] font-semibold',
    },
    NO_SCHEDULE: {
      thaiLabel: 'ไม่มีตารางเวร',
      icon: CalendarOff,
      iconColor: 'text-[#596579]',
      textColor: 'text-[#596579] font-medium',
    },
    PENDING_MAPPING: {
      thaiLabel: 'รอเชื่อมโยงรหัสสแกน',
      icon: Link2Off,
      iconColor: 'text-[#2563EB]',
      textColor: 'text-[#2563EB] font-semibold',
    },
  };

  const info = map[status] || {
    thaiLabel: status,
    icon: Clock,
    iconColor: 'text-[#596579]',
    textColor: 'text-[#273244] font-medium',
  };

  const Icon = info.icon;
  const earlyMin = Number(earlyCheckoutMinutes || 0);

  // แปลงรหัสสถานะรอง (Secondary Flags) ให้เป็นข้อความภาษาไทยที่เข้าใจง่าย
  const secondaryFlagThai =
    secondaryFlags === 'LATE_AND_MISSING_CHECKOUT'
      ? 'เข้างานสายร่วมกับไม่สแกนออก'
      : secondaryFlags === 'LATE_AND_EARLY_CHECKOUT'
      ? earlyMin > 0
        ? `เข้างานสายร่วมกับออกก่อนเวลา ${earlyMin} นาที`
        : 'เข้างานสายร่วมกับออกก่อนเวลา'
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
      <div className="inline-flex items-center gap-2 whitespace-nowrap">
        <Icon className={`w-4 h-4 shrink-0 ${info.iconColor}`} aria-hidden="true" />
        <span className={`text-[14px] leading-snug ${info.textColor}`}>{info.thaiLabel}</span>
      </div>
      {secondaryFlagThai && (
        <span className="text-[12.5px] text-[#B45309] pl-6 leading-snug">
          หมายเหตุ: {secondaryFlagThai}
        </span>
      )}
    </div>
  );
}

/**
 * แสดงสถานะการตรวจทานของฝ่ายทรัพยากรบุคคล (HR Review Status)
 */
export function ReviewStatusLabel({ status }: { status: string }) {
  if (status === 'VERIFIED_APPROVED' || status === 'REVIEWED') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-[#047857] whitespace-nowrap">
        <CheckCircle2 className="w-4 h-4 shrink-0 text-[#047857]" aria-hidden="true" />
        <span>ตรวจสอบแล้ว</span>
      </span>
    );
  }
  if (status === 'NEEDS_RE_REVIEW') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-[#B91C1C] whitespace-nowrap">
        <AlertTriangle className="w-4 h-4 shrink-0 text-[#B91C1C]" aria-hidden="true" />
        <span>ต้องตรวจสอบซ้ำ</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-[#596579] whitespace-nowrap">
      <Clock className="w-3.5 h-3.5 shrink-0 text-[#596579]" aria-hidden="true" />
      <span>รอตรวจสอบ</span>
    </span>
  );
}

/**
 * แสดงชื่อระดับสิทธิ์ผู้ใช้งาน 3 ระดับพร้อมไอคอนประจำบทบาท
 */
export function RoleLabel({ role }: { role: string }) {
  if (role === 'ADMIN') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-[#9F3F50] whitespace-nowrap">
        <ShieldCheck className="w-4 h-4 text-[#B45363] shrink-0" aria-hidden="true" />
        <span>ผู้ดูแลระบบ</span>
      </span>
    );
  }
  if (role === 'RESPONSIBLE_STAFF') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-[#2563EB] whitespace-nowrap">
        <UserCheck className="w-4 h-4 text-[#2563EB] shrink-0" aria-hidden="true" />
        <span>เจ้าหน้าที่งานบุคคล (HR)</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-[#596579] whitespace-nowrap">
      <User className="w-4 h-4 text-[#596579] shrink-0" aria-hidden="true" />
      <span>บุคลากรทั่วไป</span>
    </span>
  );
}

/**
 * แถบแจ้งเตือนข้อผิดพลาด (Error Banner) รองรับการแสดงรหัสอ้างอิงและปุ่มกดลองใหม่
 */
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
      className="border border-red-300 bg-red-50/90 px-5 py-4 rounded-xl text-[14px] text-red-950 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-[#B91C1C] shrink-0 mt-0.5" aria-hidden="true" />
        <div className="space-y-1">
          <div className="font-semibold flex flex-wrap items-center gap-2 text-[14.5px] text-[#B91C1C]">
            <span>แจ้งเตือนการตรวจสอบความปลอดภัยของระบบ</span>
            {error.code && (
              <span className="font-mono text-[12.5px] text-red-900 bg-red-100 px-2 py-0.5 rounded-md">
                รหัสข้อผิดพลาด: {error.code}
              </span>
            )}
            {error.requestId && (
              <span className="font-mono text-[12.5px] text-red-900 bg-red-100 px-2 py-0.5 rounded-md">
                Request ID: {error.requestId}
              </span>
            )}
          </div>
          <p className="text-red-900 leading-relaxed">{error.message}</p>
        </div>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="h-10 px-4 text-[13.5px] font-semibold bg-white border border-red-300 text-[#B91C1C] rounded-lg hover:bg-red-100 transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0"
        >
          <RotateCw className="w-4 h-4" />
          <span>ลองใหม่อีกครั้ง</span>
        </button>
      )}
    </div>
  );
}
