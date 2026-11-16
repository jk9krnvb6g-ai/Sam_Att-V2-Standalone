/**
 * ============================================================================
 * โมดูลเชื่อมต่อ Backend API (Frontend API Service & Token Manager)
 * ไฟล์: frontend/src/services/api.ts
 * ============================================================================
 * หน้าที่หลัก:
 * 1. จัดเก็บและดึง JWT Token จาก localStorage ของเบราว์เซอร์
 * 2. ฟังก์ชัน apiRequest(): ตัวกลางสำหรับส่ง HTTP Request ไปยัง /api/Sam_Att/*
 *    โดยแนบ Header Authorization: Bearer <token> ให้อัตโนมัติ
 * 3. แปลงข้อผิดพลาดจากฝั่งเซิร์ฟเวอร์ (เช่น 401, 403, 429, 503 Fail-Closed)
 *    ให้อยู่ในรูปออบเจกต์ ApiClientError เพื่อให้หน้าเว็บแสดงข้อความแจ้งเตือนภาษาไทยได้ทันที
 * 4. ฟังก์ชัน downloadLatenessCsv(): ดาวน์โหลดไฟล์รายงาน CSV สำหรับเปิดในโปรแกรม Excel
 */

// ระดับสิทธิ์ผู้ใช้งาน 3 ระดับตามข้อกำหนดของโรงพยาบาลสามชุก
export type UserRole = 'ADMIN' | 'RESPONSIBLE_STAFF' | 'GENERAL_USER';

// โครงสร้างข้อมูลผู้ใช้งานที่ผ่านการยืนยันตัวตนแล้ว
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

/**
 * คลาสจัดการข้อผิดพลาดจากการเรียกใช้งาน API
 * เก็บรหัส HTTP Status, รหัสข้อผิดพลาด (code), รหัสคำขอ (requestId) และสถานะ failClosed
 */
export class ApiClientError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly requestId?: string;
  public readonly failClosed?: boolean;

  constructor(status: number, code: string, message: string, requestId?: string, failClosed?: boolean) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.failClosed = failClosed;
  }
}

// พาธหลักของ Backend API บนพอร์ต 4101 เดียวกันกับหน้าเว็บ
const API_BASE = '/api/Sam_Att';
const TOKEN_STORAGE_KEY = 'sam_att_v2_token';

/**
 * อ่านค่า JWT Token ที่บันทึกไว้ในเบราว์เซอร์
 */
export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

/**
 * บันทึกหรือลบ JWT Token ในเบราว์เซอร์ (ส่งค่า null เมื่อออกจากระบบ)
 */
export function setStoredToken(token: string | null): void {
  if (token) {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

/**
 * ฟังก์ชันกลางสำหรับเรียกใช้งาน REST API ภายใต้ /api/Sam_Att/*
 * @param endpoint พาธย่อย เช่น '/auth/login' หรือ '/attendance?dateFrom=...'
 * @param options ตัวเลือกของ fetch เช่น method, body, headers
 */
export async function apiRequest<T = any>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getStoredToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> | undefined),
  };

  // หากมีการส่งข้อมูล body ให้ระบุ Content-Type เป็น JSON อัตโนมัติ
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  // แนบ JWT Token ไปกับทุกคำขอหากผู้ใช้ล็อกอินอยู่
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
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
      Boolean(errData.failClosed)
    );
  }

  // กรณีเป็นไฟล์รายงาน CSV ให้คืนค่าเป็นข้อความดิบ
  if (contentType.includes('text/csv')) {
    return (await res.text()) as unknown as T;
  }

  return (await res.json()) as T;
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
