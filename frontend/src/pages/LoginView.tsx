import React, { useState } from 'react';
import {
  HeartHandshake,
  Lock,
  User,
  ArrowRight,
  Eye,
  EyeOff,
  CalendarDays,
  Fingerprint,
  FileBarChart2,
  ShieldCheck,
} from 'lucide-react';
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
    <div className="min-h-screen bg-[#F8F7FC] flex items-center justify-center py-8 px-4 sm:px-6 lg:px-8">
      <div className="w-full max-w-[920px] his-surface overflow-hidden grid grid-cols-1 lg:grid-cols-12">
        {/* Left Institutional Hospital Panel — Soft Lavender #F1ECFA (Flat, Zero Gradient) */}
        <div className="lg:col-span-5 bg-[#F1ECFA] border-b lg:border-b-0 lg:border-r border-[#E8E4EF] p-6 sm:p-8 flex flex-col justify-between gap-8">
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl bg-[#8066B5] text-white flex items-center justify-center shrink-0">
                <HeartHandshake className="w-6 h-6" />
              </div>
              <div className="min-w-0">
                <div className="text-[12.5px] font-semibold text-[#4E3978]">
                  โรงพยาบาลสามชุก · จังหวัดสุพรรณบุรี
                </div>
                <div className="text-[12px] text-[#777287]">Sam_Att V2 Standalone</div>
              </div>
            </div>

            <div className="space-y-2">
              <h1 className="text-[22px] sm:text-[24px] font-bold text-[#292638] tracking-tight leading-snug">
                ระบบบริหารเวลาปฏิบัติงานบุคลากร
              </h1>
              <p className="text-[13.5px] text-[#777287] leading-relaxed">
                พื้นที่ทำงานกลางสำหรับการจัดตารางเวร ดึงข้อมูลสแกนลายนิ้วมือ
                ตรวจสอบการลงเวลา และสรุปรายงานส่งต่อระบบ HOSOffice
              </p>
            </div>

            <div className="pt-2 border-t border-[#E8E4EF] divide-y divide-[#E8E4EF]">
              <div className="py-3 flex items-start gap-3">
                <CalendarDays className="w-4.5 h-4.5 text-[#8066B5] shrink-0 mt-0.5" aria-hidden="true" />
                <div>
                  <div className="text-[13.5px] font-semibold text-[#292638]">ตารางเวรและกะทำงาน</div>
                  <div className="text-[12.5px] text-[#777287]">รองรับเวรเช้า บ่าย ดึก และจัดตารางหลายคนพร้อมกัน</div>
                </div>
              </div>
              <div className="py-3 flex items-start gap-3">
                <Fingerprint className="w-4.5 h-4.5 text-[#8066B5] shrink-0 mt-0.5" aria-hidden="true" />
                <div>
                  <div className="text-[13.5px] font-semibold text-[#292638]">ข้อมูลสแกนต้นฉบับที่ตรวจสอบได้</div>
                  <div className="text-[12.5px] text-[#777287]">ดึงข้อมูลจากเครื่องสแกนและจับคู่กะอัตโนมัติ</div>
                </div>
              </div>
              <div className="py-3 flex items-start gap-3">
                <FileBarChart2 className="w-4.5 h-4.5 text-[#8066B5] shrink-0 mt-0.5" aria-hidden="true" />
                <div>
                  <div className="text-[13.5px] font-semibold text-[#292638]">รายงานประจำงวดและ HOSOffice</div>
                  <div className="text-[12.5px] text-[#777287]">สรุปสถิติการมาสายและตรวจสอบก่อนส่งข้อมูลกลับ</div>
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 text-[12px] text-[#4E3978] pt-3 border-t border-[#E8E4EF]">
            <ShieldCheck className="w-4 h-4 text-[#8066B5] shrink-0" aria-hidden="true" />
            <span>ระบบควบคุมสิทธิ์ตามบทบาท (RBAC) สำหรับบุคลากรโรงพยาบาล</span>
          </div>
        </div>

        {/* Right Sign-In Workspace — Crisp White Surface */}
        <div className="lg:col-span-7 bg-white p-6 sm:p-8 lg:p-10 flex flex-col justify-center space-y-6">
          <div className="flex items-start justify-between gap-3 pb-4 border-b border-[#E8E4EF]">
            <div className="space-y-0.5">
              <h2 className="text-[20px] font-bold text-[#292638]">ลงชื่อเข้าใช้งานระบบ</h2>
              <p className="text-[13px] text-[#777287]">
                ระบุชื่อผู้ใช้งานและรหัสผ่านที่ได้รับจากกลุ่มงานบริหารทั่วไป
              </p>
              {dataMode === 'DEMO' && (
                <div className="inline-block mt-1.5 px-2.5 py-0.5 rounded-md bg-[#FEF7EA] border border-[#B87516]/25 text-[12px] font-semibold text-[#B87516]">
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
                  className="w-4 h-4 text-[#777287] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
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
                  className="w-4 h-4 text-[#777287] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
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
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1.5 text-[#777287] hover:text-[#4E3978] rounded-md transition-colors cursor-pointer"
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
            <div className="pt-4 border-t border-[#E8E4EF] space-y-2.5">
              <div className="text-[12.5px] font-semibold text-[#777287]">
                บัญชีทดสอบตามระดับสิทธิ์ (แสดงเฉพาะโหมด DEMO):
              </div>
              <div className="his-surface divide-y divide-[#E8E4EF] overflow-hidden">
                <button
                  type="button"
                  onClick={() => fillQuickTestAccount('admin', 'Admin@SamAtt2026')}
                  className="w-full text-left px-3.5 py-2.5 text-[13px] bg-white hover:bg-[#F1ECFA]/60 flex items-center justify-between transition-colors cursor-pointer"
                >
                  <div>
                    <div className="font-semibold text-[#4E3978]">ผู้ดูแลระบบ (ADMIN)</div>
                    <div className="text-[12px] text-[#777287]">จัดการทุกเมนู เครื่องสแกน และผู้ใช้งาน</div>
                  </div>
                  <span className="font-mono text-[12px] text-[#8066B5] font-semibold">admin</span>
                </button>

                <button
                  type="button"
                  onClick={() => fillQuickTestAccount('hrstaff', 'Staff@SamAtt2026')}
                  className="w-full text-left px-3.5 py-2.5 text-[13px] bg-white hover:bg-[#F1ECFA]/60 flex items-center justify-between transition-colors cursor-pointer"
                >
                  <div>
                    <div className="font-semibold text-[#5879BC]">เจ้าหน้าที่งานบุคคล (HR)</div>
                    <div className="text-[12px] text-[#777287]">ตารางเวร ตรวจสอบเวลา และรายงาน</div>
                  </div>
                  <span className="font-mono text-[12px] text-[#5879BC] font-semibold">hrstaff</span>
                </button>

                <button
                  type="button"
                  onClick={() => fillQuickTestAccount('user1003', 'User@SamAtt2026')}
                  className="w-full text-left px-3.5 py-2.5 text-[13px] bg-white hover:bg-[#F1ECFA]/60 flex items-center justify-between transition-colors cursor-pointer"
                >
                  <div>
                    <div className="font-semibold text-[#292638]">บุคลากรทั่วไป (Own-Only)</div>
                    <div className="text-[12px] text-[#777287]">ตรวจสอบเวลาและตารางเวรของตนเอง</div>
                  </div>
                  <span className="font-mono text-[12px] text-[#777287] font-semibold">user1003</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
