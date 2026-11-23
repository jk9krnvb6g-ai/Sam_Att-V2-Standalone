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
    | 'PUBLIC_HOLIDAY'
    | 'PERSONAL_HOLIDAY'
    | 'NON_WORKING_DAY'
    | 'CUSTOM_ASSIGNED'
    | 'DEFAULT_FROM_TYPE'
    | 'UNCONFIGURED_DEFAULT_RULE'
    | 'UNCONFIGURED';
  holidayLabel?: string | null;
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
    default_shift_id?: number | null;
    default_shift_code?: string | null;
    default_shift_name?: string | null;
    default_shift_category?: string | null;
    default_shift_start_time?: string | null;
    default_shift_end_time?: string | null;
    default_shift_grace_minutes?: number | null;
    default_shift_is_cross_midnight?: number | null;
    default_workdays?: string | null;
    default_start_time?: string;
    default_end_time?: string;
    default_grace_minutes?: number;
  } | null;
}

/**
 * สร้าง ViewModel สำหรับช่องวันที่ในตารางเวรรายเดือน:
 * - สูงสุด maxVisible (ค่าเริ่มต้น 2) Icon; หากมีมากกว่า 2 กะให้คืน overflowCount เพื่อแสดง +N
 * - วันไม่มีเวร / วันหยุด / นอกวันทำงาน / ยังไม่กำหนดกะ คืน kind = 'EMPTY_DASH' (แสดงเครื่องหมายขีด "—")
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
      'สถานะ: ไม่มีเวร (เจ้าหน้าที่ยกเลิกเวรวันนี้ออกแล้ว)',
      'คลิกเพื่อเพิ่มเวรหรือคืนค่ากะเริ่มต้น',
    ];
    return {
      kind: 'EMPTY_DASH',
      isClearedByStaff: true,
      totalShifts: 0,
      visibleIcons: [],
      overflowCount: 0,
      tooltipLines,
      tooltipText: tooltipLines.join('\n'),
      ariaLabel: `${formattedThaiDate} ไม่มีเวร (ยกเลิกเวรแล้ว) คลิกเพื่อจัดการ`,
    };
  }

  if (cellEff.mode === 'PUBLIC_HOLIDAY') {
    const label = cellEff.holidayLabel ? `วันหยุดราชการ (${cellEff.holidayLabel})` : 'วันหยุดราชการ';
    const tooltipLines = [
      `วันที่ ${formattedThaiDate}`,
      `สถานะ: ${label} — ไม่นำกะเริ่มต้นมาใช้`,
      'คลิกเพื่อจัดตารางเวรรายบุคคล (หากต้องขึ้นปฏิบัติงานในวันหยุด)',
    ];
    return {
      kind: 'EMPTY_DASH',
      isClearedByStaff: false,
      totalShifts: 0,
      visibleIcons: [],
      overflowCount: 0,
      tooltipLines,
      tooltipText: tooltipLines.join('\n'),
      ariaLabel: `${formattedThaiDate} ${label} คลิกเพื่อจัดเวรรายบุคคล`,
    };
  }

  if (cellEff.mode === 'PERSONAL_HOLIDAY') {
    const label = cellEff.holidayLabel ? `วันหยุดเฉพาะบุคคล (${cellEff.holidayLabel})` : 'วันหยุดเฉพาะบุคคล';
    const tooltipLines = [
      `วันที่ ${formattedThaiDate}`,
      `สถานะ: ${label} — ไม่นำกะเริ่มต้นมาใช้`,
      'คลิกเพื่อจัดการเวรรายวัน',
    ];
    return {
      kind: 'EMPTY_DASH',
      isClearedByStaff: true,
      totalShifts: 0,
      visibleIcons: [],
      overflowCount: 0,
      tooltipLines,
      tooltipText: tooltipLines.join('\n'),
      ariaLabel: `${formattedThaiDate} ${label}`,
    };
  }

  if (cellEff.mode === 'NON_WORKING_DAY') {
    const tooltipLines = [
      `วันที่ ${formattedThaiDate}`,
      'สถานะ: วันหยุดประจำสัปดาห์ (อยู่นอกวันทำงานของกะเริ่มต้น)',
      'คลิกเพื่อจัดเวรรายบุคคลเพิ่มเติมในวันนี้',
    ];
    return {
      kind: 'EMPTY_DASH',
      isClearedByStaff: false,
      totalShifts: 0,
      visibleIcons: [],
      overflowCount: 0,
      tooltipLines,
      tooltipText: tooltipLines.join('\n'),
      ariaLabel: `${formattedThaiDate} วันหยุดประจำสัปดาห์ คลิกเพื่อจัดเวร`,
    };
  }

  if (cellEff.mode === 'UNCONFIGURED_DEFAULT_RULE' || cellEff.mode === 'UNCONFIGURED') {
    const tooltipLines = [
      `วันที่ ${formattedThaiDate}`,
      'สถานะ: ยังไม่กำหนดกะ (ไม่มีเวรรายบุคคลและประเภทบุคลากรนี้ยังไม่ได้กำหนดกะเริ่มต้น)',
      'คลิกเพื่อจัดเวรรายบุคคล หรือกำหนดกะเริ่มต้นที่หัวข้อ “กะเริ่มต้นตามประเภทบุคลากร”',
    ];
    return {
      kind: 'EMPTY_DASH',
      isClearedByStaff: false,
      totalShifts: 0,
      visibleIcons: [],
      overflowCount: 0,
      tooltipLines,
      tooltipText: tooltipLines.join('\n'),
      ariaLabel: `${formattedThaiDate} ยังไม่กำหนดกะ คลิกเพื่อจัดเวร`,
    };
  }

  if (cellEff.mode === 'DEFAULT_FROM_TYPE' && cellEff.defaultRule) {
    const rule = cellEff.defaultRule;
    const startTime = String(rule.default_shift_start_time || rule.default_start_time || '').trim();
    const endTime = String(rule.default_shift_end_time || rule.default_end_time || '').trim();
    if (!startTime || !endTime) {
      const tooltipLines = [
        `วันที่ ${formattedThaiDate}`,
        'สถานะ: ยังไม่กำหนดกะ (ประเภทบุคลากรนี้ยังไม่ได้กำหนดกะเริ่มต้น)',
        'คลิกเพื่อจัดเวรรายวัน หรือกำหนดกะเริ่มต้นในแท็บแม่แบบกะทำงาน',
      ];
      return {
        kind: 'EMPTY_DASH',
        isClearedByStaff: false,
        totalShifts: 0,
        visibleIcons: [],
        overflowCount: 0,
        tooltipLines,
        tooltipText: tooltipLines.join('\n'),
        ariaLabel: `${formattedThaiDate} ยังไม่กำหนดกะ คลิกเพื่อจัดการ`,
      };
    }

    const grace = Number(rule.default_shift_grace_minutes ?? rule.default_grace_minutes ?? 15);
    const typeName = rule.personnel_type_name || 'ตามประเภทบุคลากร';
    const isCross =
      Number(rule.default_shift_is_cross_midnight ?? 0) === 1 || endTime <= startTime;
    const linkedCode = String(rule.default_shift_code || '').trim();
    const linkedName = rule.default_shift_name
      ? cleanShiftDisplayName(rule.default_shift_name)
      : '';
    const displayName = linkedName
      ? `${linkedName} (กะเริ่มต้น: ${typeName})`
      : `กะเริ่มต้น (${typeName})`;
    const iconKind = classifyShiftIconKind({
      shiftCode: linkedCode,
      shiftName: linkedName || displayName,
      shiftCategory: rule.default_shift_category,
      startTime,
      endTime,
      isCrossMidnight: isCross,
    });
    const item: CompactShiftIconItem = {
      id: rule.default_shift_id ? `default-shift-${rule.default_shift_id}` : 'default-morning',
      iconKind,
      shiftCode: linkedCode || 'DEFAULT',
      cleanName: displayName,
      timeRange: `${startTime}–${endTime}`,
      isCrossMidnight: isCross,
      isDefault: true,
    };
    const tooltipLines = [
      `วันที่ ${formattedThaiDate}`,
      `${displayName}: ${startTime}–${endTime} น. (ผ่อนผัน ${grace} นาที)`,
      linkedCode
        ? `แม่แบบกะเริ่มต้น: ${linkedCode} · คลิกเพื่อเปลี่ยนกะ เพิ่มกะ หรือตั้งเป็นวันหยุด`
        : 'สถานะ: กะเริ่มต้นอัตโนมัติ · คลิกเพื่อเปลี่ยนกะ เพิ่มกะ หรือตั้งเป็นวันหยุด',
    ];
    return {
      kind: 'DEFAULT',
      isClearedByStaff: false,
      totalShifts: 1,
      visibleIcons: [item],
      overflowCount: 0,
      tooltipLines,
      tooltipText: tooltipLines.join('\n'),
      ariaLabel: `${formattedThaiDate} ${displayName} ${startTime} ถึง ${endTime} น.`,
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

export function addDaysYmd(ymd: string, offsetDays: number): string {
  const [yStr, mStr, dStr] = String(ymd || '').split('-');
  const dt = new Date(Date.UTC(Number(yStr || 1970), Number(mStr || 1) - 1, Number(dStr || 1) + offsetDays));
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function computeClientShiftInterval(
  workDate: string,
  startTime: string,
  endTime: string,
  isCrossMidnight?: number | boolean | null
): { startAbsMin: number; endAbsMin: number; endDate: string; isCrossMidnight: boolean } {
  const [yStr, mStr, dStr] = String(workDate || '').split('-');
  const dayIndex = Math.floor(
    Date.UTC(Number(yStr || 1970), Number(mStr || 1) - 1, Number(dStr || 1)) / 86_400_000
  );
  const startMin = parseHhmmMinutes(startTime) ?? 0;
  const endMin = parseHhmmMinutes(endTime) ?? 0;
  const cross =
    Number(isCrossMidnight) === 1 || isCrossMidnight === true || endMin <= startMin;
  return {
    startAbsMin: dayIndex * 1440 + startMin,
    endAbsMin: dayIndex * 1440 + endMin + (cross ? 1440 : 0),
    endDate: cross ? addDaysYmd(workDate, 1) : workDate,
    isCrossMidnight: cross,
  };
}

/**
 * หลักการช่วงเวลา [start, end):
 * เช่น กะเช้า [08:00, 16:00) และกะบ่าย [16:00, 24:00) -> max(480, 960) = 960 ไม่น้อยกว่า min(960, 1440) = 960 -> ไม่ทับซ้อน
 */
export function intervalsOverlapHalfOpen(
  a: { startAbsMin: number; endAbsMin: number },
  b: { startAbsMin: number; endAbsMin: number }
): boolean {
  return Math.max(a.startAbsMin, b.startAbsMin) < Math.min(a.endAbsMin, b.endAbsMin);
}

export type FilteredSelectionTriState = 'unchecked' | 'indeterminate' | 'checked';

export interface FilteredSelectionStateResult {
  state: FilteredSelectionTriState;
  totalFilteredCount: number;
  selectedInFilteredCount: number;
  uniqueSelectedTotalCount: number;
  disabled: boolean;
}

/**
 * คำนวณสถานะ Checkbox เลือกทั้งหมดแบบ 3 สถานะ (Unchecked / Indeterminate / Checked)
 * โดยอิงจากรายการบุคลากรที่ตรงกับตัวกรองทั้งหมด (ไม่ใช่เฉพาะแถวที่มองเห็นในพื้นที่ Scroll)
 */
export function computeFilteredSelectionState(
  filteredIds: string[],
  selectedIds: string[]
): FilteredSelectionStateResult {
  const uniqueFiltered = Array.from(
    new Set(filteredIds.map((id) => String(id ?? '').trim()).filter(Boolean))
  );
  const uniqueSelectedSet = new Set(
    selectedIds.map((id) => String(id ?? '').trim()).filter(Boolean)
  );

  let selectedInFilteredCount = 0;
  for (const fid of uniqueFiltered) {
    if (uniqueSelectedSet.has(fid)) {
      selectedInFilteredCount++;
    }
  }

  const totalFilteredCount = uniqueFiltered.length;
  const disabled = totalFilteredCount === 0;
  let state: FilteredSelectionTriState = 'unchecked';
  if (totalFilteredCount > 0 && selectedInFilteredCount === totalFilteredCount) {
    state = 'checked';
  } else if (selectedInFilteredCount > 0) {
    state = 'indeterminate';
  }

  return {
    state,
    totalFilteredCount,
    selectedInFilteredCount,
    uniqueSelectedTotalCount: uniqueSelectedSet.size,
    disabled,
  };
}

/**
 * สลับสถานะ Checkbox เลือกทั้งหมดตามตัวกรองปัจจุบัน:
 * - หากยังเลือกไม่ครบในตัวกรองปัจจุบัน -> เพิ่มทุกคนที่ตรงตัวกรองเข้าสู่รายการที่เลือก (ไม่ซ้ำ)
 * - หากเลือกครบทุกคนในตัวกรองปัจจุบันแล้ว -> เอาออกเฉพาะคนที่ตรงตัวกรองปัจจุบัน โดยรักษารายชื่อที่เลือกจากตัวกรองอื่นไว้ครบถ้วน
 */
export function toggleSelectAllFiltered(filteredIds: string[], selectedIds: string[]): string[] {
  const uniqueFiltered = Array.from(
    new Set(filteredIds.map((id) => String(id ?? '').trim()).filter(Boolean))
  );
  const uniqueSelected = Array.from(
    new Set(selectedIds.map((id) => String(id ?? '').trim()).filter(Boolean))
  );

  if (uniqueFiltered.length === 0) {
    return uniqueSelected;
  }

  const meta = computeFilteredSelectionState(uniqueFiltered, uniqueSelected);
  if (meta.state === 'checked') {
    const filteredSet = new Set(uniqueFiltered);
    return uniqueSelected.filter((id) => !filteredSet.has(id));
  }

  const nextSet = new Set(uniqueSelected);
  for (const fid of uniqueFiltered) {
    nextSet.add(fid);
  }
  return Array.from(nextSet);
}

export interface ClientShiftOverlapDetail {
  kind: 'SAME_DAY' | 'CROSS_MIDNIGHT_NEXT_DAY';
  shiftAId: number;
  shiftAName: string;
  shiftATime: string;
  shiftACrossMidnight: boolean;
  shiftBId: number;
  shiftBName: string;
  shiftBTime: string;
  shiftBCrossMidnight: boolean;
  message: string;
}

/**
 * ตรวจสอบคู่แม่แบบกะที่มีช่วงเวลาทับซ้อนกันทั้งหมดตามหลักการช่วงเวลา [start, end)
 * - ตรวจทุกคู่ภายในวันเดียวกัน (SAME_DAY)
 * - หากมีวันที่เลือกติดกันอย่างน้อย 1 คู่ (d และ d+1) จะตรวจกะข้ามวัน (+1 วัน) เทียบกับกะในวันถัดไปด้วย (CROSS_MIDNIGHT_NEXT_DAY)
 * - กะที่สิ้นสุดเวลาเดียวกับอีกกะเริ่มต้น เช่น [08:00, 16:00) กับ [16:00, 00:00) หรือ 20:00–08:00 (+1 วัน) กับ 08:00–16:00 วันถัดไป ถือว่าไม่ทับซ้อน
 */
export function findAllClientSelectedShiftsOverlaps(
  selectedShifts: Array<{
    id: number;
    shift_code: string;
    shift_name: string;
    start_time: string;
    end_time: string;
    is_cross_midnight: number | boolean;
  }>,
  selectedDates?: string[]
): ClientShiftOverlapDetail[] {
  if (selectedShifts.length === 0) return [];

  const overlaps: ClientShiftOverlapDetail[] = [];
  const baseDate = '2026-01-01';
  const nextDate = '2026-01-02';

  // 1. ตรวจสอบการทับซ้อนกันเองในวันเดียวกัน (ทุกคู่)
  for (let i = 0; i < selectedShifts.length; i++) {
    for (let j = i + 1; j < selectedShifts.length; j++) {
      const a = selectedShifts[i];
      const b = selectedShifts[j];
      const intA = computeClientShiftInterval(baseDate, a.start_time, a.end_time, a.is_cross_midnight);
      const intB = computeClientShiftInterval(baseDate, b.start_time, b.end_time, b.is_cross_midnight);

      if (intervalsOverlapHalfOpen(intA, intB)) {
        const nameA = cleanShiftDisplayName(a.shift_name);
        const nameB = cleanShiftDisplayName(b.shift_name);
        const timeA = `${a.start_time}–${a.end_time} น.${intA.isCrossMidnight ? ' (+1 วัน)' : ''}`;
        const timeB = `${b.start_time}–${b.end_time} น.${intB.isCrossMidnight ? ' (+1 วัน)' : ''}`;
        overlaps.push({
          kind: 'SAME_DAY',
          shiftAId: Number(a.id),
          shiftAName: nameA,
          shiftATime: timeA,
          shiftACrossMidnight: intA.isCrossMidnight,
          shiftBId: Number(b.id),
          shiftBName: nameB,
          shiftBTime: timeB,
          shiftBCrossMidnight: intB.isCrossMidnight,
          message: `"${nameA}" (${timeA}) ทับซ้อนกับ "${nameB}" (${timeB}) ในวันเดียวกัน`,
        });
      }
    }
  }

  // 2. ตรวจสอบการทับซ้อนของกะข้ามวัน (+1 วัน) กับกะของวันถัดไป เมื่อมีวันที่เลือกติดกัน
  const normalizedDates = Array.from(
    new Set((selectedDates || []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''))))
  ).sort();
  const dateSet = new Set(normalizedDates);
  const hasConsecutiveDates = normalizedDates.some((d) => dateSet.has(addDaysYmd(d, 1)));

  if (hasConsecutiveDates) {
    const seenCrossPairs = new Set<string>();
    for (const a of selectedShifts) {
      const intA = computeClientShiftInterval(baseDate, a.start_time, a.end_time, a.is_cross_midnight);
      if (!intA.isCrossMidnight) continue;

      for (const b of selectedShifts) {
        const intBNext = computeClientShiftInterval(
          nextDate,
          b.start_time,
          b.end_time,
          b.is_cross_midnight
        );
        if (intervalsOverlapHalfOpen(intA, intBNext)) {
          const pairKey = `${a.id}->${b.id}`;
          if (seenCrossPairs.has(pairKey)) continue;
          seenCrossPairs.add(pairKey);

          const nameA = cleanShiftDisplayName(a.shift_name);
          const nameB = cleanShiftDisplayName(b.shift_name);
          const timeA = `${a.start_time}–${a.end_time} น. (+1 วัน)`;
          const timeB = `${b.start_time}–${b.end_time} น.${intBNext.isCrossMidnight ? ' (+1 วัน)' : ''}`;
          overlaps.push({
            kind: 'CROSS_MIDNIGHT_NEXT_DAY',
            shiftAId: Number(a.id),
            shiftAName: nameA,
            shiftATime: timeA,
            shiftACrossMidnight: true,
            shiftBId: Number(b.id),
            shiftBName: nameB,
            shiftBTime: timeB,
            shiftBCrossMidnight: intBNext.isCrossMidnight,
            message: `กะข้ามวัน "${nameA}" (${timeA}) ทับซ้อนกับ "${nameB}" (${timeB}) ของวันถัดไป`,
          });
        }
      }
    }
  }

  return overlaps;
}

