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

  constructor(status: number, code: string, message: string, requestId?: string, failClosed?: boolean) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.failClosed = failClosed;
  }
}

const API_BASE = '/api/Sam_Att';
const TOKEN_STORAGE_KEY = 'sam_att_v2_token';

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setStoredToken(token: string | null): void {
  if (token) {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

export async function apiRequest<T = any>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getStoredToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> | undefined),
  };

  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
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

  if (contentType.includes('text/csv')) {
    return (await res.text()) as unknown as T;
  }

  return (await res.json()) as T;
}

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
