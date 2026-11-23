/**
 * ============================================================================
 * โมดูลเชื่อมต่อ Backend API (Frontend API Service & HttpOnly Cookie + CSRF Manager)
 * ไฟล์: frontend/src/services/api.ts
 * ============================================================================
 * หน้าที่หลัก:
 * 1. ยกเลิกการเก็บ JWT Token ใน localStorage เพื่อป้องกันความเสี่ยงจาก XSS (แก้ไข P1 ข้อ 12)
 * 2. ใช้ HttpOnly, Secure, SameSite=Strict Cookie (`sam_att_session`) ร่วมกับ CSRF Token (`sam_att_csrf`)
 * 3. ฟังก์ชัน apiRequest(): ตัวกลางสำหรับส่ง HTTP Request ไปยัง /api/Sam_Att/*
 *    โดยตั้งค่า `credentials: 'include'` และแนบ Header `X-CSRF-Token` ให้อัตโนมัติ
 * 4. แปลงข้อผิดพลาดจากฝั่งเซิร์ฟเวอร์ให้อยู่ในรูปออบเจกต์ ApiClientError
 * 5. ฟังก์ชัน downloadLatenessCsv(): ดาวน์โหลดไฟล์รายงาน CSV สำหรับเปิดในโปรแกรม Excel
 */

export type UserRole = 'ADMIN' | 'RESPONSIBLE_STAFF' | 'GENERAL_USER';

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: UserRole;
  approvedPersonId: string | null;
  personProfile?: {
    person_id: string;
    fingle_id: string | null;
    full_name: string;
    position_name: string | null;
    department_name: string;
    personnel_type_name: string;
  } | null;
}

export class ApiClientError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly requestId?: string;
  public readonly failClosed?: boolean;
  public readonly data?: any;

  constructor(
    status: number,
    code: string,
    message: string,
    requestId?: string,
    failClosed?: boolean,
    data?: any
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.failClosed = failClosed;
    this.data = data;
  }
}

const API_BASE = '/api/Sam_Att';
const LEGACY_LOCALSTORAGE_JWT_KEY = 'sam_att_v2_token';
const CSRF_COOKIE_NAME = 'sam_att_csrf';

// เก็บเฉพาะในหน่วยความจำ (In-Memory Only) ห้ามเก็บ JWT ลง localStorage เด็ดขาด (แก้ไข P1 ข้อ 12)
// รองรับทั้ง HttpOnly Cookie (โหมดใช้งานจริง) และ In-Memory Bearer Fallback เมื่อเปิดผ่าน Cross-Origin Preview iFrame ที่เบราว์เซอร์บล็อก 3rd-party Cookie
let inMemoryCsrfToken: string | null = null;
let inMemorySessionJwt: string | null = null;

function readCsrfCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const pairs = document.cookie.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k === CSRF_COOKIE_NAME) {
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    }
  }
  return null;
}

/**
 * อ่านค่าสถานะเซสชัน/CSRF Token สำหรับตรวจสอบว่าเบราว์เซอร์มีเซสชันอยู่หรือไม่
 * พร้อมล้างค่า JWT เก่าที่อาจตกค้างใน localStorage ทิ้งอัตโนมัติ
 */
export function getStoredToken(): string | null {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(LEGACY_LOCALSTORAGE_JWT_KEY)) {
      localStorage.removeItem(LEGACY_LOCALSTORAGE_JWT_KEY);
    }
  } catch {
    // ignore storage access issues
  }
  return inMemoryCsrfToken || readCsrfCookie() || inMemorySessionJwt;
}

/**
 * บันทึกหรือล้างค่า CSRF Token ในหน่วยความจำเมื่อเข้าสู่ระบบหรือออกจากระบบ
 */
export function setStoredToken(csrfToken: string | null): void {
  inMemoryCsrfToken = csrfToken;
  if (!csrfToken) {
    inMemorySessionJwt = null;
  }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(LEGACY_LOCALSTORAGE_JWT_KEY);
    }
  } catch {
    // ignore
  }
}

/**
 * ฟังก์ชันกลางสำหรับเรียกใช้งาน REST API ภายใต้ /api/Sam_Att/*
 * ส่ง HttpOnly Cookie ไปพร้อมกับ `credentials: 'include'` และแนบ `X-CSRF-Token`
 */
export async function apiRequest<T = any>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const csrfToken = inMemoryCsrfToken || readCsrfCookie();
  const headers: Record<string, string> = {
    'X-Requested-With': 'SamAttV2Client',
    ...(options.headers as Record<string, string> | undefined),
  };

  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (csrfToken) {
    headers['X-CSRF-Token'] = csrfToken;
  }
  if (inMemorySessionJwt && !headers['Authorization']) {
    headers['Authorization'] = `Bearer ${inMemorySessionJwt}`;
  }

  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    credentials: 'include',
    headers,
  });

  const contentType = res.headers.get('content-type') || '';
  if (!res.ok) {
    let errData: any = {};
    if (contentType.includes('application/json')) {
      errData = await res.json().catch(() => ({}));
    }
    throw new ApiClientError(
      res.status,
      errData.error || errData.code || `HTTP_${res.status}`,
      errData.message || `เกิดข้อผิดพลาดในการเชื่อมต่อ (${res.status})`,
      errData.requestId,
      Boolean(errData.failClosed),
      errData
    );
  }

  if (contentType.includes('text/csv')) {
    return (await res.text()) as unknown as T;
  }

  const jsonData = await res.json();
  if (jsonData && typeof jsonData === 'object') {
    if (typeof jsonData.csrfToken === 'string') {
      inMemoryCsrfToken = jsonData.csrfToken;
    }
    if (typeof jsonData.token === 'string') {
      inMemorySessionJwt = jsonData.token;
    }
  }
  return jsonData as T;
}

/**
 * ฟังก์ชันดาวน์โหลดรายงานสถิติการมาสายเป็นไฟล์ .csv
 */
export async function downloadLatenessCsv(params: {
  dateFrom: string;
  dateTo: string;
  department?: string;
  personnelType?: string;
}): Promise<void> {
  const qs = new URLSearchParams({
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    ...(params.department ? { department: params.department } : {}),
    ...(params.personnelType ? { personnelType: params.personnelType } : {}),
  });

  const csvText = await apiRequest<string>(`/reports/lateness/export.csv?${qs.toString()}`);
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sam_att_lateness_${params.dateFrom}_${params.dateTo}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * ฟังก์ชันดาวน์โหลดไฟล์แม่แบบตารางเวร Excel (.xlsx)
 */
export async function downloadShiftImportTemplateXlsx(): Promise<void> {
  const csrfToken = inMemoryCsrfToken || readCsrfCookie();
  const headers: Record<string, string> = {
    'X-Requested-With': 'SamAttV2Client',
  };
  if (csrfToken) {
    headers['X-CSRF-Token'] = csrfToken;
  }
  if (inMemorySessionJwt) {
    headers['Authorization'] = `Bearer ${inMemorySessionJwt}`;
  }

  const res = await fetch(`${API_BASE}/shift-assignments/import-template.xlsx`, {
    method: 'GET',
    credentials: 'include',
    headers,
  });

  if (!res.ok) {
    throw new ApiClientError(
      res.status,
      `HTTP_${res.status}`,
      'ไม่สามารถดาวน์โหลดไฟล์ Template Excel ได้'
    );
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'Sam_Att_Schedule_Import_Template.xlsx';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

