/**
 * ============================================================================
 * โครงสร้างผังขั้นตอนการทำงานกลาง (Central System Workflow Configuration)
 * ไฟล์: frontend/src/data/workflowConfig.ts
 * ============================================================================
 * แยกประเภทขั้นตอนการทำงานอย่างชัดเจนตามข้อกำหนด:
 * - SEQUENTIAL  : ขั้นตอนหลักที่ควรทำตามลำดับ
 * - INDEPENDENT : ขั้นตอนที่ทำได้อย่างอิสระเมื่อต้องการ
 * - AS_NEEDED   : ขั้นตอนที่ทำเฉพาะเมื่อจำเป็น / มีรายการผิดปกติ
 * - ADMIN_ONLY  : ขั้นตอนสำหรับผู้ดูแลระบบ (ADMIN) เท่านั้น
 *
 * ทุกขั้นตอนเชื่อมโยงกับ NavViewKey จริงและ GuideContextKey ใน helpGuides.ts
 */

import { type UserRole } from '../services/api.ts';
import { type NavViewKey } from '../components/layout/Sidebar.tsx';
import { type GuideContextKey } from './helpGuides.ts';

export type WorkflowDependencyType =
  | 'SEQUENTIAL'
  | 'INDEPENDENT'
  | 'AS_NEEDED'
  | 'ADMIN_ONLY';

export type WorkflowCategoryIconKey =
  | 'shield'
  | 'users'
  | 'calendar'
  | 'radio'
  | 'clock'
  | 'clipboard'
  | 'barChart'
  | 'send'
  | 'userCheck';

export interface WorkflowStepItem {
  id: string;
  stepNumber: number;
  title: string;
  description: string;
  dependencyType: WorkflowDependencyType;
  frequencyHint: string;
  roles: UserRole[];
  roleLabel: string;
  prerequisites: string[];
  targetView: NavViewKey;
  targetMenuLabel: string;
  guideKey: GuideContextKey;
  readinessStatus: 'READY' | 'CONDITIONAL';
  readinessLabel: string;
}

export interface WorkflowCategory {
  id: string;
  number: number;
  title: string;
  shortDesc: string;
  iconKey: WorkflowCategoryIconKey;
  accentBg: string;
  accentText: string;
  accentBorder: string;
  roles: UserRole[];
  steps: WorkflowStepItem[];
  precautions: string[];
}

export interface WorkflowDependencyNode {
  id: string;
  order: number;
  label: string;
  shortNote: string;
  dependencyType: WorkflowDependencyType;
  categoryId: string;
  stepId: string;
  targetView?: NavViewKey;
  roles: UserRole[];
}

export const DEPENDENCY_TYPE_META: Record<
  WorkflowDependencyType,
  {
    label: string;
    shortDesc: string;
    textColor: string;
    bgColor: string;
    borderColor: string;
  }
> = {
  SEQUENTIAL: {
    label: 'ทำตามลำดับหลัก',
    shortDesc: 'ควรทำเรียงลำดับเพื่อให้ข้อมูลต้นทางพร้อมก่อนขั้นตอนถัดไป',
    textColor: 'text-[#4E3978]',
    bgColor: 'bg-[#F1ECFA]',
    borderColor: 'border-[#E8E4EF]',
  },
  INDEPENDENT: {
    label: 'ทำได้อย่างอิสระ',
    shortDesc: 'เปิดดูหรือตรวจสอบได้ตลอดเวลา ไม่ต้องรอครบทุกขั้นตอน',
    textColor: 'text-[#5879BC]',
    bgColor: 'bg-[#EFF4FC]',
    borderColor: 'border-[#D2E0F5]',
  },
  AS_NEEDED: {
    label: 'ทำเฉพาะเมื่อจำเป็น',
    shortDesc: 'ทำเมื่อมีการรับคนใหม่ เปลี่ยนเวร พบ NO_SCAN หรือปิดงวดประจำเดือน',
    textColor: 'text-[#B87516]',
    bgColor: 'bg-[#FEF8ED]',
    borderColor: 'border-[#F3DFBC]',
  },
  ADMIN_ONLY: {
    label: 'เฉพาะผู้ดูแลระบบ (ADMIN)',
    shortDesc: 'จำกัดสิทธิ์เฉพาะผู้ดูแลระบบส่วนกลาง',
    textColor: 'text-[#777287]',
    bgColor: 'bg-[#F8F7FC]',
    borderColor: 'border-[#E8E4EF]',
  },
};

export const WORKFLOW_CATEGORIES: WorkflowCategory[] = [
  {
    id: 'cat_personal',
    number: 1,
    title: 'ตรวจสอบเวลาและตารางเวรส่วนตัว',
    shortDesc: 'สำหรับบุคลากรทุกคน ดูเวลาเข้า-ออกงาน ตารางเวร หมายเหตุ HR และประวัติสแกนของตนเอง',
    iconKey: 'userCheck',
    accentBg: 'bg-[#F1ECFA]',
    accentText: 'text-[#4E3978]',
    accentBorder: 'border-[#E8E4EF]',
    roles: ['GENERAL_USER', 'RESPONSIBLE_STAFF', 'ADMIN'],
    steps: [
      {
        id: 'step_my_attendance',
        stepNumber: 1,
        title: 'ตรวจสอบผลการลงเวลารายวันและหมายเหตุ HR ของตนเอง',
        description:
          'เปิดดูสรุปจำนวนเวรปกติ นาทีสาย และรายการขาดสแกนตามช่วงวัน/เดือน พร้อมกด "ดูหลักฐาน" เพื่อตรวจเวลาสแกนเข้า-ออกและหมายเหตุรับรองจากฝ่ายบุคคล',
        dependencyType: 'INDEPENDENT',
        frequencyHint: 'เปิดดูได้ตลอดเวลา',
        roles: ['GENERAL_USER', 'RESPONSIBLE_STAFF', 'ADMIN'],
        roleLabel: 'ผู้ใช้งานทุกบทบาท (เฉพาะข้อมูลตนเอง)',
        prerequisites: ['บัญชีผู้ใช้ต้องผูกกับรหัสบุคลากร HOSOffice แล้ว'],
        targetView: 'myAttendance',
        targetMenuLabel: 'เวลาปฏิบัติงานของฉัน',
        guideKey: 'myAttendance',
        readinessStatus: 'READY',
        readinessLabel: 'พร้อมใช้งาน',
      },
      {
        id: 'step_my_shifts_scans',
        stepNumber: 2,
        title: 'ตรวจสอบตารางเวรและประวัติการสแกนลายนิ้วมือต้นฉบับ',
        description:
          'สลับแท็บภายในหน้า "เวลาปฏิบัติงานของฉัน" ไปยัง "ตารางเวรของฉัน" เพื่อตรวจเวลาเริ่ม-เลิกกะ และ "ประวัติการสแกนลายนิ้วมือ" เพื่อยืนยันบันทึกเวลาจากเครื่องสแกน',
        dependencyType: 'INDEPENDENT',
        frequencyHint: 'ตรวจสอบเมื่อเริ่มเดือนใหม่หรือสงสัยเวลาสแกน',
        roles: ['GENERAL_USER', 'RESPONSIBLE_STAFF', 'ADMIN'],
        roleLabel: 'ผู้ใช้งานทุกบทบาท (เฉพาะข้อมูลตนเอง)',
        prerequisites: ['มีการจัดตารางเวรและดึงข้อมูลจากเครื่องสแกนแล้ว'],
        targetView: 'myAttendance',
        targetMenuLabel: 'เวลาปฏิบัติงานของฉัน',
        guideKey: 'myAttendance',
        readinessStatus: 'READY',
        readinessLabel: 'พร้อมใช้งาน',
      },
    ],
    precautions: [
      'หน้าข้อมูลส่วนตัวเป็นแบบอ่านอย่างเดียว (Own-Only Read-Only) ไม่สามารถดูข้อมูลของผู้อื่นหรือแก้ไขเวลาสแกนเองได้',
      'หากพบเวลาไม่ตรง ลืมสแกนออก หรือไปราชการ ให้แจ้งเจ้าหน้าที่งานบุคคล (HR) พร้อมหลักฐานเพื่อบันทึกหมายเหตุ',
    ],
  },
  {
    id: 'cat_admin_users',
    number: 2,
    title: 'บัญชีผู้ใช้งาน สิทธิ์ และความปลอดภัยระบบ',
    shortDesc: 'สร้างบัญชีผู้ใช้ ผูกรหัสบุคลากร ตรวจประวัติ Audit Trail และอัปเดตระบบสำหรับผู้ดูแลระบบ',
    iconKey: 'shield',
    accentBg: 'bg-[#E9DFF5]',
    accentText: 'text-[#4E3978]',
    accentBorder: 'border-[#E8E4EF]',
    roles: ['ADMIN'],
    steps: [
      {
        id: 'step_admin_users',
        stepNumber: 1,
        title: 'สร้างบัญชีผู้ใช้ กำหนดบทบาทสิทธิ์ และผูกชื่อบุคลากร',
        description:
          'เพิ่มบัญชีผู้ใช้ใหม่ กำหนดบทบาท 3 ระดับ (ADMIN / RESPONSIBLE_STAFF / GENERAL_USER) และเชื่อมโยงกับรหัสบุคลากร HOSOffice เพื่อให้สิทธิ์ Own-Only ทำงานถูกต้อง',
        dependencyType: 'ADMIN_ONLY',
        frequencyHint: 'ทำเมื่อมีผู้ใช้ใหม่หรือเปลี่ยนบทบาทหน้าที่',
        roles: ['ADMIN'],
        roleLabel: 'ผู้ดูแลระบบ (ADMIN) เท่านั้น',
        prerequisites: ['ซิงก์ทะเบียนบุคลากรจาก HOSOffice แล้ว'],
        targetView: 'adminUsers',
        targetMenuLabel: 'ผู้ใช้งานและสิทธิ์ระบบ',
        guideKey: 'adminUsers',
        readinessStatus: 'READY',
        readinessLabel: 'พร้อมใช้งาน',
      },
      {
        id: 'step_admin_audit',
        stepNumber: 2,
        title: 'ตรวจสอบประวัติการใช้งานและบันทึกความปลอดภัย (Audit Trail)',
        description:
          'ค้นหาและตรวจสอบบันทึกเหตุการณ์สำคัญทั้งหมดแบบอ่านอย่างเดียว เช่น การเข้าสู่ระบบ การแก้ตารางเวร การ Reprocess และการส่งข้อมูลกลับ HOSOffice',
        dependencyType: 'ADMIN_ONLY',
        frequencyHint: 'ตรวจสอบตามรอบหรือเมื่อต้องสอบทานเหตุการณ์',
        roles: ['ADMIN'],
        roleLabel: 'ผู้ดูแลระบบ (ADMIN) เท่านั้น',
        prerequisites: ['เข้าสู่ระบบด้วยบัญชี ADMIN'],
        targetView: 'systemLogs',
        targetMenuLabel: 'ประวัติการใช้งานระบบ',
        guideKey: 'systemLogs',
        readinessStatus: 'READY',
        readinessLabel: 'พร้อมใช้งาน',
      },
      {
        id: 'step_admin_health',
        stepNumber: 3,
        title: 'ตรวจสอบสุขภาพระบบ (System Health Center)',
        description:
          'ตรวจสอบสถานะ Backend, ฐานข้อมูล, เครื่องสแกน, งานประมวลผลค้าง และ HOSOffice แบบอ่านอย่างเดียวโดยไม่กระทบระบบอื่น',
        dependencyType: 'ADMIN_ONLY',
        frequencyHint: 'ตรวจสอบหลังรีสตาร์ทเครื่องหรือเมื่อสังเกตความผิดปกติ',
        roles: ['ADMIN'],
        roleLabel: 'ผู้ดูแลระบบ (ADMIN) เท่านั้น',
        prerequisites: ['เข้าสู่ระบบด้วยบัญชี ADMIN'],
        targetView: 'systemHealth',
        targetMenuLabel: 'ศูนย์ตรวจสอบสถานะระบบ',
        guideKey: 'systemHealth',
        readinessStatus: 'READY',
        readinessLabel: 'พร้อมใช้งาน',
      },
      {
        id: 'step_admin_deploy',
        stepNumber: 4,
        title: 'อัปเดตระบบ Sam_Att แบบปุ่มเดียว (เมื่อมีเวอร์ชันใหม่)',
        description:
          'ตรวจสอบความพร้อมของสคริปต์ Deploy_Sam_Att.bat บน Windows Server และสั่งอัปเดตพร้อมสำรองข้อมูลอัตโนมัติในช่วงนอกเวลาเร่งด่วน',
        dependencyType: 'ADMIN_ONLY',
        frequencyHint: 'ทำเฉพาะเมื่อได้รับอนุมัติให้อัปเดตเวอร์ชันใหม่',
        roles: ['ADMIN'],
        roleLabel: 'ผู้ดูแลระบบ (ADMIN) เท่านั้น',
        prerequisites: ['ตรวจสอบว่าไม่มีรอบดึงเครื่องสแกนหรือส่งข้อมูลกำลังทำงานอยู่'],
        targetView: 'deployment',
        targetMenuLabel: 'อัปเดตระบบ Sam_Att',
        guideKey: 'deployment',
        readinessStatus: 'CONDITIONAL',
        readinessLabel: 'พร้อมใช้งานบน Windows Server ที่ติดตั้งสคริปต์แล้ว',
      },
    ],
    precautions: [
      'ตรวจสอบการเชื่อมโยงรหัสบุคลากร (Person ID) ให้ตรงตัวบุคคลทุกครั้ง ห้ามผูกสลับกับบุคคลอื่น',
      'ปิดการใช้งานบัญชีทันทีเมื่อเจ้าหน้าที่ลาออกหรือโอนย้าย',
      'ห้ามสั่งอัปเดตระบบระหว่างที่มีรอบดึงเครื่องสแกนหรือรอบส่งข้อมูลกลับ HOSOffice',
    ],
  },
  {
    id: 'cat_personnel',
    number: 3,
    title: 'การจัดการข้อมูลบุคลากร (HOSOffice)',
    shortDesc: 'ซิงก์รายชื่อบุคลากรแบบ Read-Only จาก HOSOffice และตรวจสอบปัญหา FINGLE_ID ก่อนประมวลผล',
    iconKey: 'users',
    accentBg: 'bg-[#F1ECFA]',
    accentText: 'text-[#4E3978]',
    accentBorder: 'border-[#E8E4EF]',
    roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
    steps: [
      {
        id: 'step_personnel_sync',
        stepNumber: 1,
        title: 'ซิงก์ข้อมูลบุคลากรจากฐานข้อมูล HOSOffice (Read-Only)',
        description:
          'ดึงรายชื่อ กลุ่มงาน ประเภทบุคลากร และรหัสลายนิ้วมือ (FINGLE_ID) จากตาราง hr_person ของ HOSOffice เข้าสู่ระบบอย่างปลอดภัยโดยไม่กระทบตารางเวรเดิม',
        dependencyType: 'AS_NEEDED',
        frequencyHint: 'ทำเมื่อรับบุคลากรใหม่ ย้ายแผนก หรือปรับแก้ FINGLE_ID',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        roleLabel: 'เจ้าหน้าที่ HR และ ADMIN',
        prerequisites: ['ฐานข้อมูล HOSOffice เชื่อมต่อได้ปกติ'],
        targetView: 'personnel',
        targetMenuLabel: 'ทะเบียนบุคลากร',
        guideKey: 'personnel',
        readinessStatus: 'READY',
        readinessLabel: 'พร้อมใช้งาน',
      },
      {
        id: 'step_personnel_fingle',
        stepNumber: 2,
        title: 'ตรวจสอบรายการที่ขาดหรือซ้ำซ้อนของ FINGLE_ID',
        description:
          'เปิดแท็บ "ปัญหาการจับคู่รหัสสแกน" ในหน้าทะเบียนบุคลากร เพื่อตรวจว่ามีผู้ใดยังไม่มี FINGLE_ID หรือมีรหัสซ้ำกันก่อนนำไปจับคู่เวลาสแกน',
        dependencyType: 'SEQUENTIAL',
        frequencyHint: 'ตรวจทุกครั้งหลังซิงก์บุคลากรหรือพบสถานะ PENDING_MAPPING',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        roleLabel: 'เจ้าหน้าที่ HR และ ADMIN',
        prerequisites: ['ดำเนินการซิงก์บุคลากรเรียบร้อยแล้ว'],
        targetView: 'personnel',
        targetMenuLabel: 'ทะเบียนบุคลากร',
        guideKey: 'personnel',
        readinessStatus: 'READY',
        readinessLabel: 'พร้อมใช้งาน',
      },
    ],
    precautions: [
      'ข้อมูลบุคลากรต้องอ้างอิงข้อมูลจริงจาก HOSOffice เสมอ ห้ามสร้างบุคลากรจำลองปะปนในฐานข้อมูลจริง',
      'ต้องตรวจสอบ FINGLE_ID ไม่ให้ว่างหรือซ้ำซ้อนก่อนประมวลผลเวลาปฏิบัติงาน หากซ้ำต้องแก้ไขที่ต้นทาง HOSOffice แล้วซิงก์ใหม่',
    ],
  },
  {
    id: 'cat_shifts',
    number: 4,
    title: 'การกำหนดแม่แบบกะและจัดตารางเวร',
    shortDesc: 'จัดการแม่แบบกะ กฎกะเริ่มต้นตามประเภทบุคลากร จัดเวรรายบุคคล/หลายคน/หลายกะ และนำเข้า Excel',
    iconKey: 'calendar',
    accentBg: 'bg-[#E9DFF5]',
    accentText: 'text-[#4E3978]',
    accentBorder: 'border-[#E8E4EF]',
    roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
    steps: [
      {
        id: 'step_shift_templates',
        stepNumber: 1,
        title: 'ตรวจสอบแม่แบบกะทำงานและกฎกะเริ่มต้นตามประเภทบุคลากร',
        description:
          'เปิดแท็บ "3. แม่แบบกะทำงาน" เพื่อตรวจสอบเวลาเริ่ม-เลิกงาน (รวมเวรข้ามเที่ยงคืน) นาทีผ่อนผันสาย เวลาตัดรอบ และกฎกะเช้าเริ่มต้นของข้าราชการ/พกส./ลูกจ้าง',
        dependencyType: 'AS_NEEDED',
        frequencyHint: 'ตั้งค่าครั้งแรกและตรวจเมื่อมีการปรับเกณฑ์เวลากะใหม่',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        roleLabel: 'เจ้าหน้าที่ HR และ ADMIN',
        prerequisites: ['ทราบเกณฑ์เวลากะและเวลาผ่อนผันสายของโรงพยาบาล'],
        targetView: 'shifts',
        targetMenuLabel: 'ตารางเวรและกะทำงาน',
        guideKey: 'shifts',
        readinessStatus: 'READY',
        readinessLabel: 'พร้อมใช้งาน',
      },
      {
        id: 'step_shift_bulk_or_excel',
        stepNumber: 2,
        title: 'จัดตารางเวรรายเดือน (หลายคนพร้อมกัน หรือ นำเข้าไฟล์ Excel)',
        description:
          'ใช้แท็บ "2. จัดเวร / เพิ่มเวรใหม่" เพื่อเลือกบุคลากรหลายคน เลือกหลายกะพร้อมกัน และตรวจทับซ้อนก่อนบันทึก หรือใช้ปุ่ม "นำเข้าตารางเวรจาก Excel (.xlsx)" พร้อม Preview',
        dependencyType: 'SEQUENTIAL',
        frequencyHint: 'ทำก่อนขึ้นรอบเดือนใหม่หรือเมื่อหอผู้ป่วยส่งตารางเวร',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        roleLabel: 'เจ้าหน้าที่ HR และ ADMIN',
        prerequisites: ['รายชื่อบุคลากรและแม่แบบกะพร้อมใช้งานครบถ้วน'],
        targetView: 'shifts',
        targetMenuLabel: 'ตารางเวรและกะทำงาน',
        guideKey: 'shifts',
        readinessStatus: 'READY',
        readinessLabel: 'พร้อมใช้งาน',
      },
      {
        id: 'step_shift_quick_cell',
        stepNumber: 3,
        title: 'ปรับแก้เวรรายวันหรือกำหนดวันหยุด (Quick Daily Shift Cell)',
        description:
          'ในแท็บ "1. ตารางเวรปฏิบัติงาน" คลิกที่ช่องวันที่ของบุคลากรเพื่อติ๊กเพิ่ม/ลดหลายกะ หรือเอาติ๊กออกทั้งหมดเพื่อกำหนดเป็นวันหยุด (CLEARED_ALL_SHIFTS) แล้วบันทึกทันที',
        dependencyType: 'AS_NEEDED',
        frequencyHint: 'ทำเมื่อมีการแลกเวร เปลี่ยนเวร หรือหยุดปฏิบัติงานรายวัน',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        roleLabel: 'เจ้าหน้าที่ HR และ ADMIN',
        prerequisites: ['เลือกเดือนและกลุ่มงานที่ต้องการปรับแก้ในตารางเวร'],
        targetView: 'shifts',
        targetMenuLabel: 'ตารางเวรและกะทำงาน',
        guideKey: 'shifts',
        readinessStatus: 'READY',
        readinessLabel: 'พร้อมใช้งาน',
      },
    ],
    precautions: [
      'ตรวจสอบเดือน ปี พ.ศ. รายชื่อบุคลากร และผล Preview ก่อนกดยืนยันบันทึกตารางเวรหลายคนทุกครั้ง',
      'ระบบตรวจสอบช่วงเวลาทับซ้อนแบบ [start, end) รวมถึงกะข้ามเที่ยงคืนจากวันก่อนหน้าและวันถัดไปโดยอัตโนมัติ',
      'หากมีการแก้ไขตารางเวรย้อนหลังสำหรับวันที่ผ่านมาแล้ว ควรไปสั่ง Reprocess ในเมนู "ตรวจสอบเวลาและหมายเหตุ" เพื่อให้ผลการลงเวลาอัปเดตตามตารางเวรใหม่',
    ],
  },
  {
    id: 'cat_scanners',
    number: 5,
    title: 'การดึงข้อมูลเครื่องสแกนและข้อมูลต้นฉบับ',
    shortDesc: 'ดึงข้อมูลจากเครื่องสแกนตามช่วงวันที่/เวลา (Asia/Bangkok) ตรวจผลซิงก์ และตรวจ Raw Scans',
    iconKey: 'radio',
    accentBg: 'bg-[#EFF4FC]',
    accentText: 'text-[#5879BC]',
    accentBorder: 'border-[#D2E0F5]',
    roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
    steps: [
      {
        id: 'step_scanner_sync',
        stepNumber: 1,
        title: 'ดึงข้อมูลจากเครื่องสแกนลายนิ้วมือตามช่วงวันที่และเวลา',
        description:
          'เลือกโหมด "ดึงข้อมูลวันนี้", "กำหนดช่วงวันที่และเวลา" (วันเดียวกัน/ข้ามวัน/ข้ามเดือน) หรือ "ดึงข้อมูลทั้งหมด" แล้วกดสั่งดึงข้อมูล ระบบจะคัดกรองช่วงเวลาบน Backend กันซ้ำ และประมวลผล Attendance ให้อัตโนมัติ',
        dependencyType: 'SEQUENTIAL',
        frequencyHint: 'ทำประจำวัน หรือเมื่อต้องการดึงข้อมูลซ่อมเฉพาะช่วงเวลา',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        roleLabel: 'เจ้าหน้าที่ HR และ ADMIN',
        prerequisites: ['เครื่องสแกนออนไลน์ในเครือข่ายโรงพยาบาลและสถานะเปิดใช้งานปกติ'],
        targetView: 'scanners',
        targetMenuLabel: 'เครื่องสแกนและรอบดึงข้อมูล',
        guideKey: 'scanners',
        readinessStatus: 'CONDITIONAL',
        readinessLabel: 'เชื่อมต่อเครื่องจริงผ่าน ScannerSyncCli.exe บน Server',
      },
      {
        id: 'step_raw_scans_verify',
        stepNumber: 2,
        title: 'ตรวจสอบข้อมูลสแกนต้นฉบับ (Raw Scans) และสถานะการจับคู่',
        description:
          'ตรวจสอบบันทึกสแกน 6 ฟิลด์ต้นฉบับที่ถูกคุ้มครองแบบห้ามแก้ไข/ลบ และตรวจหารายการที่ขึ้น UNMATCHED หรือ CONFLICT เพื่อตามแก้ FINGLE_ID',
        dependencyType: 'AS_NEEDED',
        frequencyHint: 'ตรวจเมื่อมีรายการสแกนไม่ขึ้นหรือจับคู่ชื่อบุคลากรไม่ได้',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        roleLabel: 'เจ้าหน้าที่ HR และ ADMIN',
        prerequisites: ['มีการดึงข้อมูลจากเครื่องสแกนเข้าสู่ระบบแล้ว'],
        targetView: 'rawScans',
        targetMenuLabel: 'ข้อมูลสแกนต้นฉบับ',
        guideKey: 'rawScans',
        readinessStatus: 'READY',
        readinessLabel: 'พร้อมใช้งาน',
      },
    ],
    precautions: [
      'ข้อมูล Raw Scan ต้องเป็นข้อมูลจริงจากเครื่องสแกนเท่านั้น ห้ามสร้างข้อมูลสแกนปลอมขึ้นเองเด็ดขาด',
      'ระบบคัดกรองเวลาตามเขตเวลา Asia/Bangkok บน Backend ก่อนบันทึกลง raw_scans จึงไม่มีรายการนอกช่วงหลุดเข้าไปในฐานข้อมูล',
      'หากมีรอบดึงข้อมูลอัตโนมัติหรือผู้ใช้อื่นกำลังดึงข้อมูลอยู่ ระบบจะล็อกป้องกันการซิงก์ซ้อนกันจนกว่ารอบเดิมจะเสร็จ',
    ],
  },
  {
    id: 'cat_attendance',
    number: 6,
    title: 'การตรวจสอบการลงเวลาและการมาสาย',
    shortDesc: 'ตรวจสอบผลการเข้า-ออกงานทั้งโรงพยาบาล กรองสถานะมาสาย ขาดสแกน และตรวจสอบหลักฐานรายบุคคล',
    iconKey: 'clock',
    accentBg: 'bg-[#F1ECFA]',
    accentText: 'text-[#4E3978]',
    accentBorder: 'border-[#E8E4EF]',
    roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
    steps: [
      {
        id: 'step_hr_attendance_list',
        stepNumber: 1,
        title: 'ตรวจสอบรายการลงเวลาเข้า-ออกงานและการมาสายทั้งโรงพยาบาล',
        description:
          'เลือกช่วงเวลา กรองสถานะ (ปกติ / มาสาย / ไม่พบสแกน / ไม่สแกนออก) ค้นหาชื่อบุคลากร และกด "ดูรายละเอียด" เพื่อตรวจหลักฐานเวลาสแกนเข้า-ออกและรหัสอ้างอิง Raw Scan',
        dependencyType: 'SEQUENTIAL',
        frequencyHint: 'ตรวจสอบประจำวันหรือรายสัปดาห์หลังดึงข้อมูลสแกน',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        roleLabel: 'เจ้าหน้าที่ HR และ ADMIN',
        prerequisites: ['ดึงข้อมูลจากเครื่องสแกนและระบบประมวลผลการลงเวลาแล้ว'],
        targetView: 'hrAttendance',
        targetMenuLabel: 'รายการลงเวลาทั้งหมด',
        guideKey: 'hrAttendance',
        readinessStatus: 'READY',
        readinessLabel: 'พร้อมใช้งาน',
      },
      {
        id: 'step_hr_work_center',
        stepNumber: 2,
        title: 'จัดการคิวงานเร่งด่วนประจำวันผ่านศูนย์ปฏิบัติงาน HR',
        description:
          'ติดตามคิวงานแยกตามระดับความเร่งด่วน (ขาดสแกน, มาสาย, ค้างรับรอง, FINGLE_ID ไม่สมบูรณ์) พร้อม Saved Filter และทางลัดไปยังหน้าดำเนินการ',
        dependencyType: 'INDEPENDENT',
        frequencyHint: 'ใช้เป็นหน้าเริ่มต้นงานประจำวันของฝ่ายบุคคล',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        roleLabel: 'เจ้าหน้าที่ HR และ ADMIN',
        prerequisites: ['มีข้อมูลเวรหรือผลการลงเวลาในระบบ'],
        targetView: 'hrWorkCenter',
        targetMenuLabel: 'ศูนย์ปฏิบัติงาน HR',
        guideKey: 'hrWorkCenter',
        readinessStatus: 'READY',
        readinessLabel: 'พร้อมใช้งาน',
      },
    ],
    precautions: [
      'เวลาเข้าสายคำนวณตามเวลาผ่อนผันของกะ Snapshot ที่บุคลากรได้รับมอบหมายในวันนั้น',
      'หากพบว่าบุคลากรขึ้นสถานะผิดปกติเพราะเพิ่งเปลี่ยนเวรหรือเพิ่งแก้ FINGLE_ID ให้ไปสั่ง Reprocess ในหมวดถัดไป',
    ],
  },
  {
    id: 'cat_review_reprocess',
    number: 7,
    title: 'การจัดการ NO_SCAN หมายเหตุ และการประมวลผลใหม่',
    shortDesc: 'บันทึกเหตุผลประกอบการลา/ไปราชการ/ลืมสแกนออก รับรองผล HR และ Reprocess อย่างปลอดภัย',
    iconKey: 'clipboard',
    accentBg: 'bg-[#FEF8ED]',
    accentText: 'text-[#B87516]',
    accentBorder: 'border-[#F3DFBC]',
    roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
    steps: [
      {
        id: 'step_noscan_notes',
        stepNumber: 1,
        title: 'จัดการรายการ NO_SCAN / ลืมสแกนออก บันทึกเหตุผล และรับรองผล HR',
        description:
          'เปิดแผง "ตรวจสอบ / หมายเหตุ" เลือกประเภทเหตุผล (ไปราชการ / ลา / ลืมสแกนออกที่มีหลักฐาน / เครื่องขัดข้อง) บันทึกหมายเหตุชี้แจง และกดรับรองผลการตรวจสอบ',
        dependencyType: 'AS_NEEDED',
        frequencyHint: 'ทำเมื่อมีรายการผิดปกติหรือได้รับเอกสารชี้แจงจากบุคลากร',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        roleLabel: 'เจ้าหน้าที่ HR และ ADMIN',
        prerequisites: ['มีหลักฐานใบลา หนังสือไปราชการ หรือคำชี้แจงที่ตรวจสอบแล้ว'],
        targetView: 'attendanceReview',
        targetMenuLabel: 'ตรวจสอบเวลาและหมายเหตุ',
        guideKey: 'attendanceReview',
        readinessStatus: 'READY',
        readinessLabel: 'พร้อมใช้งาน',
      },
      {
        id: 'step_reprocess',
        stepNumber: 2,
        title: 'จำลองผล (Preview) และสั่งประมวลผลเวลาใหม่ (Reprocess)',
        description:
          'เมื่อมีการแก้ตารางเวรย้อนหลัง แก้ปัญหา FINGLE_ID หรือดึงสแกนเพิ่ม ให้ระบุช่วงวันที่ กด "จำลองผลก่อนประมวลผล (Preview)" ตรวจความเปลี่ยนแปลง แล้วจึงยืนยันคำนวณเวลาใหม่',
        dependencyType: 'AS_NEEDED',
        frequencyHint: 'ทำเฉพาะเมื่อมีการปรับตารางเวรย้อนหลังหรือดึงข้อมูลสแกนเพิ่มเติม',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        roleLabel: 'เจ้าหน้าที่ HR และ ADMIN',
        prerequisites: ['ปรับแก้ตารางเวรหรือดึงสแกนล่าสุดเสร็จแล้ว'],
        targetView: 'attendanceReview',
        targetMenuLabel: 'ตรวจสอบเวลาและหมายเหตุ',
        guideKey: 'attendanceReview',
        readinessStatus: 'READY',
        readinessLabel: 'พร้อมใช้งาน',
      },
      {
        id: 'step_completeness',
        stepNumber: 3,
        title: 'ตรวจสอบความครบถ้วนของข้อมูลย้อนหลังและเติมข้อมูลอย่างปลอดภัย',
        description:
          'ตรวจหาเวรที่ยังไม่มีบันทึกผลลงเวลา สแกนดิบค้างประมวลผล และรหัสสแกนไม่สมบูรณ์ พร้อมพรีวิวและเติมข้อมูลย้อนหลังแบบ Idempotent',
        dependencyType: 'AS_NEEDED',
        frequencyHint: 'ทำก่อนปิดรอบเดือนหรือหลังแก้ไขรหัส FINGLE_ID / ตารางเวรย้อนหลัง',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        roleLabel: 'เจ้าหน้าที่ HR และ ADMIN',
        prerequisites: ['ตรวจสอบเดือนเป้าหมายว่ายังไม่ถูกปิดรอบ (CLOSED)'],
        targetView: 'completeness',
        targetMenuLabel: 'ตรวจความครบถ้วนย้อนหลัง',
        guideKey: 'completeness',
        readinessStatus: 'READY',
        readinessLabel: 'พร้อมใช้งาน',
      },
      {
        id: 'step_monthly_closing',
        stepNumber: 4,
        title: 'ตรวจสอบความพร้อมและปิดรอบเวลาปฏิบัติงานประจำเดือน',
        description:
          'ตรวจสอบ Blocking Issues และ Warnings ประจำเดือน บันทึก Snapshot ปิดรอบ และล็อกการแก้ไขข้อมูลเดือนที่ปิดแล้ว (รองรับ Reopen เฉพาะ ADMIN)',
        dependencyType: 'AS_NEEDED',
        frequencyHint: 'ทำเมื่อสิ้นสุดรอบเดือนและ HR ตรวจรับรองครบถ้วนแล้ว',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        roleLabel: 'เจ้าหน้าที่ HR และ ADMIN',
        prerequisites: ['รายการที่บล็อกการปิดรอบ (Blocking Issues) เป็น 0'],
        targetView: 'monthlyClosing',
        targetMenuLabel: 'ปิดรอบประจำเดือน',
        guideKey: 'monthlyClosing',
        readinessStatus: 'READY',
        readinessLabel: 'พร้อมใช้งาน',
      },
    ],
    precautions: [
      'การบันทึกเหตุผล NO_SCAN ต้องไม่สร้างเวลาสแกนปลอม และไม่เปลี่ยนแปลงข้อมูลสแกนต้นฉบับ',
      'การสั่ง Reprocess จะไม่ทำลายข้อมูล Raw Scan เดิม และจะไม่ลบหมายเหตุหรือผลการรับรองที่ HR บันทึกไว้แล้ว',
      'กด Preview เพื่อตรวจสอบผลกระทบทุกครั้งก่อนกด Execute Reprocess หรือเติมข้อมูลความครบถ้วน',
    ],
  },
  {
    id: 'cat_reports_dashboard',
    number: 8,
    title: 'แดชบอร์ดภาพรวม ศูนย์รายงาน 11 ประเภท และส่งออก Excel/CSV',
    shortDesc: 'ติดตามตัวชี้วัดภาพรวมองค์กร เจาะลึกรายกลุ่มงาน ออกรายงานมาตรฐาน 11 ประเภท และส่งออก .xlsx / CSV',
    iconKey: 'barChart',
    accentBg: 'bg-[#EDF8F4]',
    accentText: 'text-[#198568]',
    accentBorder: 'border-[#C2E6DA]',
    roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
    steps: [
      {
        id: 'step_dashboard',
        stepNumber: 1,
        title: 'ติดตามภาพรวม KPI สัดส่วนสถานะ 100% และเจาะลึกรายกลุ่มงาน',
        description:
          'ดูจำนวนบุคลากรที่มีเวร สถานะปกติ ผู้มาสาย (แยกคนไม่ซ้ำ/จำนวนครั้ง) รายการค้างตรวจสอบ และคลิกเจาะลึกดูรายชื่อจริงได้ทันที',
        dependencyType: 'INDEPENDENT',
        frequencyHint: 'เปิดดูได้ตลอดเวลาเพื่อติดตามงานประจำวัน/ประจำเดือน',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        roleLabel: 'เจ้าหน้าที่ HR และ ADMIN',
        prerequisites: ['มีข้อมูลการลงเวลาในช่วงวันที่ที่เลือก'],
        targetView: 'dashboard',
        targetMenuLabel: 'แดชบอร์ดภาพรวม',
        guideKey: 'dashboard',
        readinessStatus: 'READY',
        readinessLabel: 'พร้อมใช้งาน',
      },
      {
        id: 'step_reports_csv',
        stepNumber: 2,
        title: 'ออกรายงาน 11 ประเภทและส่งออกไฟล์ Excel (.xlsx) / CSV',
        description:
          'เลือกรายงานที่ต้องการจากศูนย์รายงาน (เช่น สรุปภาพรวม, รายวัน, มาสาย, ออกก่อน, ขาดสแกน, ปฏิบัติงานวันหยุด, ลาครึ่งวัน ฯลฯ) แล้วส่งออกเป็น Excel (.xlsx) หรือ CSV ภาษาไทย',
        dependencyType: 'INDEPENDENT',
        frequencyHint: 'ทำเมื่อสิ้นงวดประจำเดือนหรือเมื่อผู้บริหารขอรายงาน',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        roleLabel: 'เจ้าหน้าที่ HR และ ADMIN (บุคลากรทั่วไปดูรายงานตนเอง)',
        prerequisites: ['แนะนำให้รับรองรายการค้างในงวดนั้นให้ครบก่อนออกรายงานสรุป'],
        targetView: 'reports',
        targetMenuLabel: 'ศูนย์รายงานและส่งออก',
        guideKey: 'reports',
        readinessStatus: 'READY',
        readinessLabel: 'พร้อมใช้งาน',
      },
    ],
    precautions: [
      'ควรตรวจสอบให้แน่ใจว่าดึงข้อมูลจากเครื่องสแกนครบทุกเครื่องและตรวจรับรองรายการค้างครบแล้วก่อนสรุปรายงานประจำเดือน',
    ],
  },
  {
    id: 'cat_hosoffice_push',
    number: 9,
    title: 'การตรวจสอบและส่งข้อมูลกลับ HOSOffice',
    shortDesc: 'จำลองชุดข้อมูล Dry-Run Preview ตรวจความสมบูรณ์ และส่งข้อมูลจริงตามสิทธิ์และสถานะระบบ',
    iconKey: 'send',
    accentBg: 'bg-[#F1ECFA]',
    accentText: 'text-[#4E3978]',
    accentBorder: 'border-[#E8E4EF]',
    roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
    steps: [
      {
        id: 'step_push_preview',
        stepNumber: 1,
        title: 'ตรวจสอบและสร้างชุดข้อมูลจำลอง (Dry-Run Preview)',
        description:
          'เลือกงวดวันที่แล้วกด "1. ตรวจสอบและสร้างชุดข้อมูลจำลอง (Preview)" เพื่อตรวจรายการที่ผ่านเกณฑ์และรายการไม่ผ่านเกณฑ์โดยยังไม่มีการเขียนลงฐานข้อมูล HOSOffice',
        dependencyType: 'SEQUENTIAL',
        frequencyHint: 'ทำก่อนปิดงวดส่งข้อมูลทุกครั้ง (ปลอดภัยต่อฐานข้อมูลปลายทาง)',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        roleLabel: 'เจ้าหน้าที่ HR และ ADMIN',
        prerequisites: ['ตรวจสอบเวลาและรับรองรายการค้างในงวดนั้นเรียบร้อยแล้ว'],
        targetView: 'hosofficePush',
        targetMenuLabel: 'ส่งข้อมูลกลับ HOSOffice',
        guideKey: 'hosofficePush',
        readinessStatus: 'READY',
        readinessLabel: 'โหมด Preview พร้อมใช้งานทันที',
      },
      {
        id: 'step_push_live',
        stepNumber: 2,
        title: 'ส่งข้อมูลจริงกลับไปยังระบบ HOSOffice (เมื่อเปิดสิทธิ์และพร้อมจริง)',
        description:
          'เมื่อตรวจสอบ Preview ครบถ้วนและระบบได้รับอนุมัติให้เปิดใช้งาน Live Push แล้ว จึงกดปุ่มส่งข้อมูลจริงและยืนยันในหน้าต่าง ConfirmDialog พร้อมตรวจสอบประวัติและ Idempotency Key',
        dependencyType: 'AS_NEEDED',
        frequencyHint: 'ทำเฉพาะรอบปิดงวดที่อนุมัติแล้วเท่านั้น',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        roleLabel: 'เจ้าหน้าที่ HR และ ADMIN (เมื่อเปิดสิทธิ์บน Server)',
        prerequisites: [
          'ผ่านขั้นตอน Preview แล้วไม่พบข้อผิดพลาด',
          'Server เปิดใช้งาน HOSOFFICE_LIVE_PUSH_ENABLED=true และอยู่ในโหมด REAL',
        ],
        targetView: 'hosofficePush',
        targetMenuLabel: 'ส่งข้อมูลกลับ HOSOffice',
        guideKey: 'hosofficePush',
        readinessStatus: 'CONDITIONAL',
        readinessLabel: 'ล็อกเพื่อความปลอดภัยจนกว่าผู้ดูแลระบบจะเปิดใช้งานจริง',
      },
    ],
    precautions: [
      'การส่งข้อมูลไป HOSOffice ต้องดำเนินการโดยผู้มีสิทธิ์เท่านั้น และต้องผ่านการตรวจสอบด้วยโหมด Preview ก่อนทุกครั้ง',
      'ห้ามเปิดใช้งานการส่งข้อมูลจริงระหว่างการทดลองใช้งานหรือในโหมด DEMO',
    ],
  },
];

export const WORKFLOW_DEPENDENCY_NODES: WorkflowDependencyNode[] = [
  // สำหรับบุคลากรทั่วไป (GENERAL_USER)
  {
    id: 'node_general_login',
    order: 1,
    label: 'เข้าสู่ระบบ',
    shortNote: 'ยืนยันตัวตนตามสิทธิ์',
    dependencyType: 'SEQUENTIAL',
    categoryId: 'cat_personal',
    stepId: 'step_my_attendance',
    targetView: 'myAttendance',
    roles: ['GENERAL_USER'],
  },
  {
    id: 'node_general_attendance',
    order: 2,
    label: 'ตรวจเวลาของฉัน',
    shortNote: 'ดูเข้า-ออก/สาย/หมายเหตุ HR',
    dependencyType: 'INDEPENDENT',
    categoryId: 'cat_personal',
    stepId: 'step_my_attendance',
    targetView: 'myAttendance',
    roles: ['GENERAL_USER'],
  },
  {
    id: 'node_general_shifts_scans',
    order: 3,
    label: 'ตรวจตารางเวรและสแกน',
    shortNote: 'ตรวจกะและหลักฐานสแกนดิบ',
    dependencyType: 'INDEPENDENT',
    categoryId: 'cat_personal',
    stepId: 'step_my_shifts_scans',
    targetView: 'myAttendance',
    roles: ['GENERAL_USER'],
  },

  // สำหรับ HR และ ADMIN
  {
    id: 'node_admin_accounts',
    order: 1,
    label: 'ตั้งค่าบัญชีและสิทธิ์',
    shortNote: 'สร้างบัญชี/ผูกบุคลากร',
    dependencyType: 'ADMIN_ONLY',
    categoryId: 'cat_admin_users',
    stepId: 'step_admin_users',
    targetView: 'adminUsers',
    roles: ['ADMIN'],
  },
  {
    id: 'node_personnel',
    order: 2,
    label: 'ตรวจบุคลากร HOSOffice',
    shortNote: 'ซิงก์รายชื่อ & FINGLE_ID',
    dependencyType: 'AS_NEEDED',
    categoryId: 'cat_personnel',
    stepId: 'step_personnel_sync',
    targetView: 'personnel',
    roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
  },
  {
    id: 'node_shifts',
    order: 3,
    label: 'แม่แบบกะและตารางเวร',
    shortNote: 'จัดเวร/Excel/แก้รายวัน',
    dependencyType: 'SEQUENTIAL',
    categoryId: 'cat_shifts',
    stepId: 'step_shift_bulk_or_excel',
    targetView: 'shifts',
    roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
  },
  {
    id: 'node_scanner',
    order: 4,
    label: 'ดึงข้อมูลเครื่องสแกน',
    shortNote: 'เลือกช่วงวันเวลา + คำนวณอัตโนมัติ',
    dependencyType: 'SEQUENTIAL',
    categoryId: 'cat_scanners',
    stepId: 'step_scanner_sync',
    targetView: 'scanners',
    roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
  },
  {
    id: 'node_attendance',
    order: 5,
    label: 'ตรวจเวลาและการมาสาย',
    shortNote: 'ตรวจผลเข้า-ออกทั้งโรงพยาบาล',
    dependencyType: 'SEQUENTIAL',
    categoryId: 'cat_attendance',
    stepId: 'step_hr_attendance_list',
    targetView: 'hrAttendance',
    roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
  },
  {
    id: 'node_noscan',
    order: 6,
    label: 'จัดการ NO_SCAN / Reprocess',
    shortNote: 'บันทึกเหตุผล & รับรองผล',
    dependencyType: 'AS_NEEDED',
    categoryId: 'cat_review_reprocess',
    stepId: 'step_noscan_notes',
    targetView: 'attendanceReview',
    roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
  },
  {
    id: 'node_reports',
    order: 7,
    label: 'แดชบอร์ดและรายงาน CSV',
    shortNote: 'ติดตาม KPI & ส่งออก Excel',
    dependencyType: 'INDEPENDENT',
    categoryId: 'cat_reports_dashboard',
    stepId: 'step_reports_csv',
    targetView: 'reports',
    roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
  },
  {
    id: 'node_push',
    order: 8,
    label: 'ส่งข้อมูลกลับ HOSOffice',
    shortNote: 'Preview ก่อนส่งจริงตามสิทธิ์',
    dependencyType: 'AS_NEEDED',
    categoryId: 'cat_hosoffice_push',
    stepId: 'step_push_preview',
    targetView: 'hosofficePush',
    roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
  },
];

export function getVisibleWorkflowCategories(role: UserRole): WorkflowCategory[] {
  const filtered = WORKFLOW_CATEGORIES.filter((cat) => cat.roles.includes(role));
  // จัดเรียงลำดับหมายเลขหมวดที่มองเห็นตามบทบาทเพื่อให้เลขเรียงต่อเนื่องอ่านง่าย
  if (role === 'GENERAL_USER') {
    return filtered.map((cat, idx) => ({ ...cat, number: idx + 1 }));
  }
  // สำหรับ ADMIN / RESPONSIBLE_STAFF แสดงหมวดงานหลักก่อน แล้วตามด้วยหมวดข้อมูลส่วนตัว
  const operational = filtered.filter((c) => c.id !== 'cat_personal');
  const personal = filtered.filter((c) => c.id === 'cat_personal');
  return [...operational, ...personal].map((cat, idx) => ({
    ...cat,
    number: idx + 1,
    steps: cat.steps.filter((s) => s.roles.includes(role)),
  }));
}

export function getVisibleDependencyNodes(role: UserRole): WorkflowDependencyNode[] {
  return WORKFLOW_DEPENDENCY_NODES.filter((n) => n.roles.includes(role)).map((n, idx) => ({
    ...n,
    order: idx + 1,
  }));
}
