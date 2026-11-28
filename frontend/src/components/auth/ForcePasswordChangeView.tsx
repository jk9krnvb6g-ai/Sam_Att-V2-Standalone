/**
 * ============================================================================
 * หน้าจอบังคับเปลี่ยนรหัสผ่านเมื่อเข้าสู่ระบบครั้งแรก / หลังรีเซ็ต (Forced Password Change)
 * ไฟล์: frontend/src/components/auth/ForcePasswordChangeView.tsx
 * ============================================================================
 */
import React, { useState } from 'react';
import { KeyRound, Loader2, LogOut, ShieldCheck, AlertTriangle } from 'lucide-react';
import { apiRequest, ApiClientError, type AuthUser } from '../../services/api.ts';

export function ForcePasswordChangeView({
  user,
  onPasswordChanged,
  onLogout,
}: {
  user: AuthUser;
  onPasswordChanged: () => void;
  onLogout: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!currentPassword || !newPassword || !confirmNewPassword) {
      setError('กรุณากรอกข้อมูลรหัสผ่านให้ครบทุกช่อง');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setError('รหัสผ่านใหม่และยืนยันรหัสผ่านใหม่ไม่ตรงกัน');
      return;
    }
    if (newPassword.length < 8) {
      setError('รหัสผ่านใหม่ต้องมีความยาวอย่างน้อย 8 ตัวอักษร');
      return;
    }
    if (newPassword === currentPassword) {
      setError('รหัสผ่านใหม่ต้องแตกต่างจากรหัสผ่านชั่วคราวเดิม');
      return;
    }

    setSubmitting(true);
    try {
      await apiRequest('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword,
          newPassword,
        }),
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmNewPassword('');
      onPasswordChanged();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
      } else {
        setError('ไม่สามารถเปลี่ยนรหัสผ่านได้ กรุณาลองใหม่อีกครั้ง');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#F8F7FC] flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white border border-[#E8E4EF] rounded-2xl shadow-sm overflow-hidden">
        <div className="px-6 py-5 border-b border-[#E8E4EF] bg-[#F8F7FC]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#8066B5] text-white flex items-center justify-center shrink-0">
              <KeyRound className="w-5 h-5" aria-hidden="true" />
            </div>
            <div>
              <div className="text-[12.5px] font-semibold text-[#4E3978]">
                ความปลอดภัยบัญชีผู้ใช้งาน
              </div>
              <h1 className="text-[18px] font-bold text-[#292638]">
                กรุณาตั้งรหัสผ่านใหม่ก่อนเข้าใช้งาน
              </h1>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="p-3.5 rounded-xl bg-[#F1ECFA] border border-[#E8E4EF] text-[13px] text-[#4E3978] space-y-1">
            <div className="font-bold">
              บัญชี: {user.displayName} ({user.username})
            </div>
            <p className="text-[#292638] leading-relaxed">
              บัญชีนี้ใช้รหัสผ่านชั่วคราวจากการสร้างหรือรีเซ็ตโดยผู้ดูแลระบบ กรุณากำหนดรหัสผ่านส่วนตัวใหม่ (อย่างน้อย 8 ตัวอักษร และประกอบด้วยตัวอักษรพิมพ์ใหญ่/เล็ก ตัวเลข หรือสัญลักษณ์อย่างน้อย 2 ประเภท)
            </p>
          </div>

          {error && (
            <div
              role="alert"
              className="p-3.5 rounded-xl bg-[#FDF2F4] border border-[#E5B8BF] text-[#8E2837] text-[13px] font-medium flex items-start gap-2"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          <div>
            <label htmlFor="force-current-pwd" className="ent-label">
              รหัสผ่านชั่วคราว / รหัสผ่านปัจจุบัน
            </label>
            <input
              id="force-current-pwd"
              type="password"
              required
              autoComplete="current-password"
              disabled={submitting}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="กรอกรหัสผ่านชั่วคราวที่ได้รับ"
              className="ent-input w-full"
            />
          </div>

          <div>
            <label htmlFor="force-new-pwd" className="ent-label">
              รหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)
            </label>
            <input
              id="force-new-pwd"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              disabled={submitting}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="กำหนดรหัสผ่านใหม่ที่คาดเดายาก"
              className="ent-input w-full"
            />
          </div>

          <div>
            <label htmlFor="force-confirm-pwd" className="ent-label">
              ยืนยันรหัสผ่านใหม่อีกครั้ง
            </label>
            <input
              id="force-confirm-pwd"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              disabled={submitting}
              value={confirmNewPassword}
              onChange={(e) => setConfirmNewPassword(e.target.value)}
              placeholder="พิมพ์รหัสผ่านใหม่อีกครั้ง"
              className="ent-input w-full"
            />
          </div>

          <div className="pt-2 flex flex-col sm:flex-row items-center justify-between gap-2.5">
            <button
              type="button"
              disabled={submitting}
              onClick={onLogout}
              className="ent-btn-secondary w-full sm:w-auto"
            >
              <LogOut className="w-4 h-4 text-[#777287]" aria-hidden="true" />
              <span>ออกจากระบบ</span>
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="ent-btn-primary w-full sm:w-auto"
            >
              {submitting ? (
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              ) : (
                <ShieldCheck className="w-4 h-4" aria-hidden="true" />
              )}
              <span>{submitting ? 'กำลังบันทึกรหัสผ่าน...' : 'บันทึกรหัสผ่านใหม่และเข้าใช้งาน'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
