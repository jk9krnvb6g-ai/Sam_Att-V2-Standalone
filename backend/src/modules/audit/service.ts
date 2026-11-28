import { dbExecute } from '../../database/adapter.ts';

export interface AuditLogInput {
  requestId: string;
  actorUsername: string;
  actorRole: string;
  ipAddress: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  result: 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILURE' | 'DENIED' | 'BLOCKED';
  errorCode?: string | null;
  detail?: Record<string, unknown> | null;
}

const SENSITIVE_KEYS = new Set([
  'password',
  'confirmpassword',
  'confirm_password',
  'temporarypassword',
  'temporary_password',
  'temppassword',
  'newpassword',
  'new_password',
  'currentpassword',
  'current_password',
  'passwordhash',
  'password_hash',
  'token',
  'jwt',
  'secret',
  'authorization',
  'cookie',
]);

function scrubSensitive(obj: Record<string, unknown> | null | undefined): string | null {
  if (!obj) return null;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      clean[k] = '[REDACTED]';
    } else {
      clean[k] = v;
    }
  }
  return JSON.stringify(clean);
}

export async function writeAuditLog(input: AuditLogInput): Promise<void> {
  try {
    await dbExecute(
      `INSERT INTO audit_logs (
        request_id, actor_username, actor_role, ip_address, action,
        target_type, target_id, result, error_code, detail_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.requestId || 'req-internal',
        input.actorUsername || 'anonymous',
        input.actorRole || 'UNAUTHENTICATED',
        input.ipAddress || '127.0.0.1',
        input.action,
        input.targetType,
        input.targetId ?? null,
        input.result,
        input.errorCode ?? null,
        scrubSensitive(input.detail),
      ]
    );
  } catch {
    // Do not crash request flow if DB is down during error audit logging
  }
}
