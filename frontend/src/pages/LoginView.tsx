import React, { useState } from 'react';
import { HeartHandshake, Lock, User, ArrowRight, Eye, EyeOff } from 'lucide-react';
import { apiRequest, setStoredToken, type AuthUser, ApiClientError } from '../services/api.ts';
import { ErrorBanner } from '../components/StatusText.tsx';
import { RequiredMark } from '../components/common/SharedComponents.tsx';
import { PageHelpAction } from '../components/common/ContextualHelp.tsx';

export function LoginView({
  dataMode = 'REAL',
  onLoginSuccess,
}: {
  dataMode?: 'REAL' | 'DEMO';
  onLoginSuccess: (user: AuthUser, resolvedMode?: 'REAL' | 'DEMO') => void;
}) {
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
      const res = await apiRequest<{
        token: string;
        csrfToken?: string;
        dataMode?: 'REAL' | 'DEMO';
        user: AuthUser;
      }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      setStoredToken(res.csrfToken || 'cookie-session-active');
      const me = await apiRequest<{ user: AuthUser; dataMode?: 'REAL' | 'DEMO' }>('/auth/me');
      onLoginSuccess(me.user, me.dataMode || res.dataMode || dataMode);
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
    <div className="min-h-screen bg-[#F8F7FC] flex flex-col justify-center py-10 px-4 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-[460px] space-y-6">
        {/* Hospital Identity Header */}
        <div className="flex flex-col items-center text-center space-y-3">
          <div className="w-13 h-13 rounded-2xl bg-[#8E70C9] text-white flex items-center justify-center shadow-xs">
            <HeartHandshake className="w-7 h-7" />
          </div>
          <div className="space-y-1">
            <div className="text-[13px] font-semibold text-[#543B7A]">
              โรงพยาบาลสามชุก · จังหวัดสุพรรณบุรี
            </div>
            <h1 className="text-[24px] font-bold text-[#262238] tracking-tight">
              ระบบบริหารเวลาปฏิบัติงานบุคลากร
            </h1>
            <p className="text-[13.5px] text-[#746B83]">
              Sam_Att V2 Standalone · สำหรับเจ้าหน้าที่และบุคลากรโรงพยาบาล
            </p>
          </div>
        </div>

        {/* Main Login Card */}
        <div className="ent-card p-6 sm:p-8 space-y-5">
          <div className="flex items-center justify-between gap-2 pb-4 border-b border-[#E6DFF0]">
            <div>
              <h2 className="text-[18px] font-bold text-[#262238]">เข้าสู่ระบบ</h2>
              {dataMode === 'DEMO' && (
                <div className="text-[12.5px] font-semibold text-[#B87516] mt-0.5">
                  โหมดข้อมูลตัวอย่าง (DEMO)
                </div>
              )}
            </div>
            <PageHelpAction guideKey="login" compact />
          </div>

          <ErrorBanner error={error} />

          <form className="space-y-4" onSubmit={handleSubmit}>
            <div>
              <label htmlFor="username" className="ent-label">
                ชื่อผู้ใช้งาน (Username) <RequiredMark />
              </label>
              <div className="relative flex items-center">
                <User
                  className="w-4 h-4 text-[#746B83] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
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
                  className="ent-input ent-input-with-icon w-full pr-4"
                  placeholder="ระบุชื่อบัญชีผู้ใช้งาน"
                />
              </div>
            </div>

            <div>
              <label htmlFor="password" className="ent-label">
                รหัสผ่าน <RequiredMark />
              </label>
              <div className="relative flex items-center">
                <Lock
                  className="w-4 h-4 text-[#746B83] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
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
                  className="ent-input ent-input-with-icon w-full pr-11"
                  placeholder="ระบุรหัสผ่าน"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1.5 text-[#746B83] hover:text-[#543B7A] rounded-md transition-colors cursor-pointer"
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
              className="ent-btn-primary w-full h-11 text-[15px] mt-1"
            >
              <span>{loading ? 'กำลังตรวจสอบข้อมูลผู้ใช้งาน...' : 'เข้าสู่ระบบ'}</span>
              {!loading && <ArrowRight className="w-4 h-4" />}
            </button>
          </form>

          {/* DEMO-Only Quick Role Switcher (Never rendered in REAL mode) */}
          {dataMode === 'DEMO' && (
            <div className="pt-4 border-t border-[#E6DFF0] space-y-2.5">
              <div className="text-[12.5px] font-semibold text-[#746B83]">
                บัญชีทดสอบตามระดับสิทธิ์ (แสดงเฉพาะโหมด DEMO):
              </div>
              <div className="grid grid-cols-1 gap-2">
                <button
                  type="button"
                  onClick={() => fillQuickTestAccount('admin', 'Admin@SamAtt2026')}
                  className="text-left px-3.5 py-2.5 text-[13px] border border-[#E6DFF0] rounded-xl bg-[#F8F7FC] hover:bg-[#F2EDFA] hover:border-[#8E70C9] flex items-center justify-between transition-colors cursor-pointer"
                >
                  <div>
                    <div className="font-semibold text-[#543B7A]">ผู้ดูแลระบบ (ADMIN)</div>
                    <div className="text-[12px] text-[#746B83]">จัดการทุกเมนู เครื่องสแกน และผู้ใช้งาน</div>
                  </div>
                  <span className="font-mono text-[12px] text-[#543B7A] font-medium">
                    admin
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => fillQuickTestAccount('hrstaff', 'Staff@SamAtt2026')}
                  className="text-left px-3.5 py-2.5 text-[13px] border border-[#E6DFF0] rounded-xl bg-[#F8F7FC] hover:bg-[#F2EDFA] hover:border-[#8E70C9] flex items-center justify-between transition-colors cursor-pointer"
                >
                  <div>
                    <div className="font-semibold text-[#5879BC]">เจ้าหน้าที่งานบุคคล (HR)</div>
                    <div className="text-[12px] text-[#746B83]">ตารางเวร ตรวจสอบเวลา และรายงาน</div>
                  </div>
                  <span className="font-mono text-[12px] text-[#5879BC] font-medium">
                    hrstaff
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => fillQuickTestAccount('user1003', 'User@SamAtt2026')}
                  className="text-left px-3.5 py-2.5 text-[13px] border border-[#E6DFF0] rounded-xl bg-[#F8F7FC] hover:bg-[#F2EDFA] hover:border-[#8E70C9] flex items-center justify-between transition-colors cursor-pointer"
                >
                  <div>
                    <div className="font-semibold text-[#262238]">บุคลากรทั่วไป (Own-Only)</div>
                    <div className="text-[12px] text-[#746B83]">ตรวจสอบเวลาและตารางเวรของตนเอง</div>
                  </div>
                  <span className="font-mono text-[12px] text-[#746B83] font-medium">
                    user1003
                  </span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
