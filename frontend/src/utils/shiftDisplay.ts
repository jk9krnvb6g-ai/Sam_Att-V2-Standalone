/**
 * ============================================================================
 * ยูทิลิตี้จัดหมวดหมู่ Icon และสร้าง ViewModel สำหรับช่องตารางเวรรายเดือนแบบกะทัดรัด
 * ไฟล์: frontend/src/utils/shiftDisplay.ts
 * ============================================================================
 */

export type ShiftIconKind =
  | 'MORNING'
  | 'AFTERNOON'
  | 'NIGHT'
  | 'MORNING_AFTERNOON'
  | 'AFTERNOON_NIGHT'
  | 'FULL_DAY'
  | 'SPECIAL';

export interface ShiftDisplayInput {
  shiftCode?: string | null;
  shiftName?: string | null;
  shiftCategory?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  isCrossMidnight?: number | boolean | null;
}

export interface CompactShiftIconItem {
  id: string;
  iconKind: ShiftIconKind;
  shiftCode: string;
  cleanName: string;
  timeRange: string;
  isCrossMidnight: boolean;
  isDefault: boolean;
}

export interface CompactMonthlyCellViewModel {
  kind: 'DEFAULT' | 'CUSTOM' | 'EMPTY_DASH';
  isClearedByStaff: boolean;
  totalShifts: number;
  visibleIcons: CompactShiftIconItem[];
  overflowCount: number;
  tooltipLines: string[];
  tooltipText: string;
  ariaLabel: string;
}

export function cleanShiftDisplayName(rawName: string | null | undefined): string {
  const str = String(rawName || '').trim();
  if (!str) return 'เวรปฏิบัติงาน';
  const cleaned = str
    .replace(/\s*\(\s*\d{1,2}:\d{2}\s*[-–—]\s*\d{1,2}:\d{2}(?:\s*น\.?)?\s*\)\s*$/u, '')
    .trim();
  return cleaned || str;
}

function parseHhmmMinutes(hhmm: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (Number.isNaN(h) || Number.isNaN(min)) return null;
  return h * 60 + min;
}

/**
 * จำแนกประเภท Icon ของแม่แบบกะทำงานอย่างเป็นมาตรฐาน:
 * - MORNING -> ดวงอาทิตย์ (Sun)
 * - AFTERNOON -> พระอาทิตย์ตก (Sunset)
 * - NIGHT -> พระจันทร์ (Moon)
 * - MORNING_AFTERNOON -> เช้า-บ่าย (Sunrise)
 * - AFTERNOON_NIGHT -> บ่าย-ดึก (CloudMoon)
 * - FULL_DAY -> ทั้งวัน (Clock)
 * - SPECIAL -> กะพิเศษ/อื่น ๆ (Sparkles)
 */
export function classifyShiftIconKind(input: ShiftDisplayInput): ShiftIconKind {
  const code = String(input.shiftCode || '').trim().toUpperCase();
  const cat = String(input.shiftCategory || '').trim().toUpperCase();
  const name = String(input.shiftName || '').trim();

  if (
    cat === 'MORNING_AFTERNOON' ||
    code.startsWith('MA-') ||
    code.startsWith('MORAFT') ||
    name.includes('เช้า–บ่าย') ||
    name.includes('เช้า-บ่าย')
  ) {
    return 'MORNING_AFTERNOON';
  }

  if (
    cat === 'AFTERNOON_NIGHT' ||
    code.startsWith('AN-') ||
    code.startsWith('AFTNIG') ||
    name.includes('บ่าย–ดึก') ||
    name.includes('บ่าย-ดึก')
  ) {
    return 'AFTERNOON_NIGHT';
  }

  if (
    cat === 'FULL_DAY' ||
    code.startsWith('FULL') ||
    name.includes('ทั้งวัน') ||
    name.includes('24 ชม')
  ) {
    return 'FULL_DAY';
  }

  if (
    cat === 'NIGHT' ||
    code.startsWith('NIG') ||
    name.includes('กะดึก') ||
    name.includes('เวรดึก')
  ) {
    return 'NIGHT';
  }

  if (
    cat === 'AFTERNOON' ||
    code.startsWith('AFT') ||
    name.includes('กะบ่าย') ||
    name.includes('เวรบ่าย')
  ) {
    return 'AFTERNOON';
  }

  if (
    cat === 'MORNING' ||
    cat === 'OFFICIAL' ||
    code.startsWith('MOR') ||
    code.startsWith('OFF-') ||
    name.includes('กะเช้า') ||
    name.includes('เวรเช้า') ||
    name.includes('ราชการ')
  ) {
    return 'MORNING';
  }

  if (cat === 'SPECIAL' || code.startsWith('EXT') || name.includes('พิเศษ')) {
    return 'SPECIAL';
  }

  // Fallback จากช่วงเวลาจริง
  const startMin = parseHhmmMinutes(input.startTime);
  const endMin = parseHhmmMinutes(input.endTime);
  const isCross =
    Number(input.isCrossMidnight) === 1 ||
    input.isCrossMidnight === true ||
    (startMin !== null && endMin !== null && endMin <= startMin);

  if (startMin !== null) {
    if (startMin >= 300 && startMin < 720 && !isCross) {
      if (endMin !== null && endMin >= 1140) return 'MORNING_AFTERNOON';
      return 'MORNING';
    }
    if (startMin >= 720 && startMin < 1140) {
      return isCross ? 'AFTERNOON_NIGHT' : 'AFTERNOON';
    }
    if (startMin >= 1140 || startMin < 300) {
      return isCross ? 'SPECIAL' : 'NIGHT';
    }
  }

  return 'SPECIAL';
}

export function getShiftIconKindThaiLabel(kind: ShiftIconKind): string {
  switch (kind) {
    case 'MORNING':
      return 'กะเช้า';
    case 'AFTERNOON':
      return 'กะบ่าย';
    case 'NIGHT':
      return 'กะดึก';
    case 'MORNING_AFTERNOON':
      return 'กะเช้า–บ่าย';
    case 'AFTERNOON_NIGHT':
      return 'กะบ่าย–ดึก';
    case 'FULL_DAY':
      return 'กะทั้งวัน';
    case 'SPECIAL':
    default:
      return 'กะพิเศษ';
  }
}

export interface EffectiveCellLike {
  mode:
    | 'CLEARED_ALL_SHIFTS'
    | 'CUSTOM_ASSIGNED'
    | 'DEFAULT_FROM_TYPE'
    | 'UNCONFIGURED_DEFAULT_RULE'
    | 'UNCONFIGURED';
  activeItems: Array<{
    id?: number | string;
    snapshot_shift_code?: string;
    snapshot_shift_name?: string;
    snapshot_start_time?: string;
    snapshot_end_time?: string;
    snapshot_is_cross_midnight?: number;
    shift_category?: string;
  }>;
  defaultRule?: {
    personnel_type_name?: string;
    default_start_time?: string;
    default_end_time?: string;
    default_grace_minutes?: number;
  } | null;
}

/**
 * สร้าง ViewModel สำหรับช่องวันที่ในตารางเวรรายเดือน:
 * - สูงสุด maxVisible (ค่าเริ่มต้น 2) Icon; หากมีมากกว่า 2 กะให้คืน overflowCount เพื่อแสดง +N
 * - วันไม่มีเวรคืน kind = 'EMPTY_DASH' (แสดงเครื่องหมายขีด "—")
 * - กะเริ่มต้น (DEFAULT) แยกจากกะที่เจ้าหน้าที่กำหนดเอง (CUSTOM) ชัดเจน
 */
export function buildCompactMonthlyCellViewModel(
  cellEff: EffectiveCellLike,
  formattedThaiDate: string,
  maxVisible = 2
): CompactMonthlyCellViewModel {
  if (cellEff.mode === 'CLEARED_ALL_SHIFTS') {
    const tooltipLines = [
      `วันที่ ${formattedThaiDate}`,
      'สถานะ: ไม่มีเวร (เจ้าหน้าที่ลบเวรวันนี้ออกแล้ว)',
      'คลิกเพื่อเพิ่มเวรหรือคืนค่ากะเช้าเริ่มต้น',
    ];
    return {
      kind: 'EMPTY_DASH',
      isClearedByStaff: true,
      totalShifts: 0,
      visibleIcons: [],
      overflowCount: 0,
      tooltipLines,
      tooltipText: tooltipLines.join('\n'),
      ariaLabel: `${formattedThaiDate} ไม่มีเวร (ลบเวรแล้ว) คลิกเพื่อจัดการ`,
    };
  }

  if (cellEff.mode === 'DEFAULT_FROM_TYPE' && cellEff.defaultRule) {
    const startTime = cellEff.defaultRule.default_start_time || '08:00';
    const endTime = cellEff.defaultRule.default_end_time || '16:00';
    const grace = Number(cellEff.defaultRule.default_grace_minutes ?? 15);
    const typeName = cellEff.defaultRule.personnel_type_name || 'ตามประเภทบุคลากร';
    const item: CompactShiftIconItem = {
      id: 'default-morning',
      iconKind: 'MORNING',
      shiftCode: startTime === '07:30' ? 'MOR-0730' : 'MOR-0816',
      cleanName: `กะเช้าเริ่มต้น (${typeName})`,
      timeRange: `${startTime}–${endTime}`,
      isCrossMidnight: false,
      isDefault: true,
    };
    const tooltipLines = [
      `วันที่ ${formattedThaiDate}`,
      `กะเช้าเริ่มต้น (${typeName}): ${startTime}–${endTime} น. (ผ่อนผัน ${grace} นาที)`,
      'สถานะ: กะเริ่มต้นอัตโนมัติ · คลิกเพื่อเปลี่ยนกะ เพิ่มกะ หรือตั้งเป็นวันหยุด',
    ];
    return {
      kind: 'DEFAULT',
      isClearedByStaff: false,
      totalShifts: 1,
      visibleIcons: [item],
      overflowCount: 0,
      tooltipLines,
      tooltipText: tooltipLines.join('\n'),
      ariaLabel: `${formattedThaiDate} กะเช้าเริ่มต้น ${startTime} ถึง ${endTime} น.`,
    };
  }

  if (cellEff.mode === 'CUSTOM_ASSIGNED' && cellEff.activeItems.length > 0) {
    const mapped: CompactShiftIconItem[] = cellEff.activeItems.map((a, idx) => {
      const startTime = String(a.snapshot_start_time || '08:00');
      const endTime = String(a.snapshot_end_time || '16:00');
      const isCross = Number(a.snapshot_is_cross_midnight) === 1;
      const cleanName = cleanShiftDisplayName(a.snapshot_shift_name);
      return {
        id: String(a.id ?? idx),
        iconKind: classifyShiftIconKind({
          shiftCode: a.snapshot_shift_code,
          shiftName: a.snapshot_shift_name,
          shiftCategory: a.shift_category,
          startTime,
          endTime,
          isCrossMidnight: isCross,
        }),
        shiftCode: String(a.snapshot_shift_code || ''),
        cleanName,
        timeRange: `${startTime}–${endTime}`,
        isCrossMidnight: isCross,
        isDefault: false,
      };
    });

    const visibleIcons = mapped.slice(0, maxVisible);
    const overflowCount = Math.max(0, mapped.length - maxVisible);
    const tooltipLines = [
      `วันที่ ${formattedThaiDate} (เวรที่กำหนดเอง ${mapped.length} กะ)`,
      ...mapped.map(
        (m) =>
          `• ${m.cleanName} (${m.timeRange} น.${m.isCrossMidnight ? ' ข้ามวัน' : ''})`
      ),
      'คลิกเพื่อดูรายละเอียด แก้ไข หรือเพิ่ม/ลบกะ',
    ];

    return {
      kind: 'CUSTOM',
      isClearedByStaff: false,
      totalShifts: mapped.length,
      visibleIcons,
      overflowCount,
      tooltipLines,
      tooltipText: tooltipLines.join('\n'),
      ariaLabel: `${formattedThaiDate} เวรที่กำหนดเอง ${mapped.length} กะ: ${mapped
        .map((m) => `${m.cleanName} ${m.timeRange}`)
        .join(', ')}`,
    };
  }

  const tooltipLines = [
    `วันที่ ${formattedThaiDate}`,
    'สถานะ: ไม่มีเวร',
    'คลิกเพื่อจัดเวรให้บุคลากรในวันนี้',
  ];
  return {
    kind: 'EMPTY_DASH',
    isClearedByStaff: false,
    totalShifts: 0,
    visibleIcons: [],
    overflowCount: 0,
    tooltipLines,
    tooltipText: tooltipLines.join('\n'),
    ariaLabel: `${formattedThaiDate} ไม่มีเวร คลิกเพื่อจัดเวร`,
  };
}

/**
 * ตรวจสอบเบื้องต้นฝั่ง Client ว่าแม่แบบกะหลายกะที่ผู้ใช้ติ๊กเลือกพร้อมกันมีช่วงเวลาทับซ้อนกันเองหรือไม่
 * (Backend ยังคงตรวจสอบซ้ำทั้งวันเดียวกันและกะข้ามวันเป็นแหล่งความจริงหลัก)
 */
export function findClientSelectedShiftsOverlap(
  selectedShifts: Array<{
    id: number;
    shift_code: string;
    shift_name: string;
    start_time: string;
    end_time: string;
    is_cross_midnight: number;
  }>
): { shiftAName: string; shiftBName: string; message: string } | null {
  if (selectedShifts.length < 2) return null;

  const toInterval = (s: { start_time: string; end_time: string; is_cross_midnight: number }) => {
    const start = parseHhmmMinutes(s.start_time) ?? 0;
    const endRaw = parseHhmmMinutes(s.end_time) ?? 0;
    const isCross = Number(s.is_cross_midnight) === 1 || endRaw <= start;
    return { start, end: endRaw + (isCross ? 1440 : 0) };
  };

  for (let i = 0; i < selectedShifts.length; i++) {
    for (let j = i + 1; j < selectedShifts.length; j++) {
      const a = selectedShifts[i];
      const b = selectedShifts[j];
      const intA = toInterval(a);
      const intB = toInterval(b);
      if (Math.max(intA.start, intB.start) < Math.min(intA.end, intB.end)) {
        const nameA = cleanShiftDisplayName(a.shift_name);
        const nameB = cleanShiftDisplayName(b.shift_name);
        return {
          shiftAName: nameA,
          shiftBName: nameB,
          message: `แม่แบบกะ "${nameA}" (${a.start_time}–${a.end_time} น.) และ "${nameB}" (${b.start_time}–${b.end_time} น.) มีช่วงเวลาทับซ้อนกัน ไม่สามารถจัดควบคู่กันในวันเดียวกันได้`,
        };
      }
    }
  }
  return null;
}
