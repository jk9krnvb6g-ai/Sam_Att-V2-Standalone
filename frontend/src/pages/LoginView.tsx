import React, { useState } from 'react';
import { HeartHandshake, Lock, User, ArrowRight, Eye, EyeOff } from 'lucide-react';
import { apiRequest, setStoredToken, type AuthUser, ApiClientError } from '../services/api.ts';
import { ErrorBanner } from '../components/StatusText.tsx';
import { RequiredMark } from '../components/common/SharedComponents.tsx';

export function LoginView({ onLoginSuccess }: { onLoginSuccess: (user: AuthUser) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiRequest<{ token: string; csrfToken?: string; user: AuthUser }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      setStoredToken(res.csrfToken || 'cookie-session-active');
      const me = await apiRequest<{ user: AuthUser }>('/auth/me');
      onLoginSuccess(me.user);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      } else {
        setError({ message: 'ไม่สามารถเข้าสู่ระบบได้ กรุณาตรวจสอบการเชื่อมต่อเครือข่าย' });
      }
    } finally {
      setLoading(false);
    }
  }

  function fillQuickTestAccount(u: string, p: string) {
    setUsername(u);
    setPassword(p);
    setError(null);
  }

  return (
    <div className="min-h-screen bg-[#FFF9F9] flex flex-col justify-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-lg">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-[#B45363] text-white flex items-center justify-center shadow-sm shrink-0">
            <HeartHandshake className="w-6 h-6" />
          </div>
          <div>
            <div className="text-[13px] font-semibold text-[#9F3F50]">
              กระทรวงสาธารณสุข · จังหวัดสุพรรณบุรี
            </div>
            <h1 className="text-[22px] sm:text-[24px] font-bold text-[#273244] tracking-tight leading-snug">
              โรงพยาบาลสามชุก · ระบบบริหารเวลาปฏิบัติงาน
            </h1>
          </div>
        </div>
      </div>

      <div className="mt-7 sm:mx-auto sm:w-full sm:max-w-lg">
        <div className="ent-card py-8 px-6 sm:px-9 space-y-6">
          <div className="border-b border-[#E7E2E5] pb-4">
            <h2 className="text-[19px] font-bold text-[#273244]">
              ลงชื่อเข้าใช้งานสำหรับบุคลากร
            </h2>
            <p className="mt-1 text-[14px] text-[#596579] leading-relaxed">
              ตรวจสอบเวลาเข้า–ออกงาน ตารางเวรหมุนเวียน และรายงานประจำเดือนตามสิทธิ์การปฏิบัติงาน
            </p>
          </div>

          <ErrorBanner error={error} />

          <form className="space-y-5" onSubmit={handleSubmit}>
            <div>
              <label htmlFor="username" className="ent-label">
                ชื่อบัญชีผู้ใช้งาน <RequiredMark />
              </label>
              <div className="relative flex items-center">
                <User
                  className="w-4 h-4 text-[#596579] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                  aria-hidden="true"
                />
                <input
                  id="username"
                  name="username"
                  type="text"
                  autoComplete="username"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="ent-input ent-input-with-icon w-full pl-11 pr-4"
                  placeholder="ระบุชื่อบัญชีผู้ใช้งานของคุณ"
                />
              </div>
            </div>

            <div>
              <label htmlFor="password" className="ent-label">
                รหัสผ่าน <RequiredMark />
              </label>
              <div className="relative flex items-center">
                <Lock
                  className="w-4 h-4 text-[#596579] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                  aria-hidden="true"
                />
                <input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="ent-input ent-input-with-icon w-full pl-11 pr-11"
                  placeholder="ระบุรหัสผ่าน"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-[#596579] hover:text-[#273244] rounded-md transition-colors"
                  aria-label={showPassword ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
                  title={showPassword ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="ent-btn-primary w-full"
            >
              <span>{loading ? 'กำลังตรวจสอบข้อมูลผู้ใช้งาน...' : 'เข้าสู่ระบบปฏิบัติงาน'}</span>
              {!loading && <ArrowRight className="w-4 h-4" />}
            </button>
          </form>

          <div className="pt-5 border-t border-[#E7E2E5] space-y-3">
            <div className="text-[13.5px] font-semibold text-[#273244]">
              บัญชีสำหรับทดสอบระบบตามระดับสิทธิ์ (คลิกเพื่อกรอกข้อมูลอัตโนมัติ):
            </div>
            <div className="grid grid-cols-1 gap-2">
              <button
                type="button"
                onClick={() => fillQuickTestAccount('admin', 'Admin@SamAtt2026')}
                className="text-left px-4 py-3 text-[13.5px] border border-[#E7E2E5] rounded-xl bg-[#FFF9F9] hover:bg-[#F9E8EB]/60 hover:border-[#B45363]/40 flex items-center justify-between transition-colors"
              >
                <div>
                  <div className="font-semibold text-[#9F3F50]">1. ผู้ดูแลระบบ (ADMIN)</div>
                  <div className="text-[12.5px] text-[#596579]">ดูแลระบบทั้งหมด เครื่องสแกน และผู้ใช้งาน</div>
                </div>
                <span className="font-mono text-[12.5px] text-[#273244] bg-white px-2.5 py-1 rounded-md border border-[#E7E2E5]">
                  admin · SAM-P001
                </span>
              </button>

              <button
                type="button"
                onClick={() => fillQuickTestAccount('hrstaff', 'Staff@SamAtt2026')}
                className="text-left px-4 py-3 text-[13.5px] border border-[#E7E2E5] rounded-xl bg-[#FFF9F9] hover:bg-[#F9E8EB]/60 hover:border-[#B45363]/40 flex items-center justify-between transition-colors"
              >
                <div>
                  <div className="font-semibold text-[#2563EB]">2. เจ้าหน้าที่งานบุคคล (HR)</div>
                  <div className="text-[12.5px] text-[#596579]">จัดการตารางเวร ตรวจสอบเวลา และออกรายงาน</div>
                </div>
                <span className="font-mono text-[12.5px] text-[#273244] bg-white px-2.5 py-1 rounded-md border border-[#E7E2E5]">
                  hrstaff · SAM-P002
                </span>
              </button>

              <button
                type="button"
                onClick={() => fillQuickTestAccount('user1003', 'User@SamAtt2026')}
                className="text-left px-4 py-3 text-[13.5px] border border-[#E7E2E5] rounded-xl bg-[#FFF9F9] hover:bg-[#F9E8EB]/60 hover:border-[#B45363]/40 flex items-center justify-between transition-colors"
              >
                <div>
                  <div className="font-semibold text-[#273244]">3. บุคลากรทั่วไป (Own-Only)</div>
                  <div className="text-[12.5px] text-[#596579]">ดูประวัติการลงเวลาและตารางเวรเฉพาะของตนเอง</div>
                </div>
                <span className="font-mono text-[12.5px] text-[#273244] bg-white px-2.5 py-1 rounded-md border border-[#E7E2E5]">
                  user1003 · SAM-P003
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
