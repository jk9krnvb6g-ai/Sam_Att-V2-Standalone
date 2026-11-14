import React, { useState } from 'react';
import { ShieldCheck, Lock, User } from 'lucide-react';
import { apiRequest, setStoredToken, type AuthUser, ApiClientError } from '../services/api.ts';
import { ErrorBanner } from '../components/StatusText.tsx';

export function LoginView({ onLoginSuccess }: { onLoginSuccess: (user: AuthUser) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiRequest<{ token: string; user: AuthUser }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      setStoredToken(res.token);
      const me = await apiRequest<{ user: AuthUser }>('/auth/me');
      onLoginSuccess(me.user);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      } else {
        setError({ message: 'ไม่สามารถเข้าสู่ระบบได้ กรุณาตรวจสอบการเชื่อมต่อ' });
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
    <div className="min-h-screen bg-slate-100 flex flex-col justify-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="flex items-center justify-center gap-3">
          <div className="w-11 h-11 rounded-lg bg-teal-800 text-white flex items-center justify-center">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">
              โรงพยาบาลสามชุก · Sam_Att V2
            </h1>
            <p className="text-xs text-slate-600">
              ระบบบริหารจัดการเวลาปฏิบัติงาน (Standalone HTTPS Port 4101)
            </p>
          </div>
        </div>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white py-8 px-6 border border-slate-200 rounded-xl sm:px-8 space-y-6">
          <div>
            <h2 className="text-base font-semibold text-slate-900">เข้าสู่ระบบสำหรับบุคลากรและผู้ดูแล</h2>
            <p className="mt-1 text-xs text-slate-500">
              ระบบตรวจสอบสิทธิ์ 3 ระดับ (ADMIN · RESPONSIBLE_STAFF · GENERAL_USER) พร้อมบังคับ Own-Only
            </p>
          </div>

          <ErrorBanner error={error} />

          <form className="space-y-4" onSubmit={handleSubmit}>
            <div>
              <label htmlFor="username" className="block text-xs font-medium text-slate-700 mb-1">
                ชื่อผู้ใช้งาน (Username)
              </label>
              <div className="relative">
                <User className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                <input
                  id="username"
                  name="username"
                  type="text"
                  autoComplete="username"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700"
                  placeholder="ระบุชื่อผู้ใช้งาน"
                />
              </div>
            </div>

            <div>
              <label htmlFor="password" className="block text-xs font-medium text-slate-700 mb-1">
                รหัสผ่าน (Password)
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700"
                  placeholder="ระบุรหัสผ่าน"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 text-sm font-semibold text-white bg-teal-800 hover:bg-teal-900 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap"
            >
              {loading ? 'กำลังตรวจสอบสิทธิ์...' : 'เข้าสู่ระบบ (Sign In)'}
            </button>
          </form>

          <div className="pt-4 border-t border-slate-200 space-y-2">
            <div className="text-xs font-medium text-slate-600">
              บัญชีทดสอบระบบตามบทบาท (Synthetic Non-PII Sandbox Accounts):
            </div>
            <div className="grid grid-cols-1 gap-2">
              <button
                type="button"
                onClick={() => fillQuickTestAccount('admin', 'Admin@SamAtt2026')}
                className="text-left px-3 py-2 text-xs border border-slate-200 rounded-lg hover:bg-slate-50 flex items-center justify-between"
              >
                <span className="font-semibold text-teal-900">1. ADMIN (ผู้ดูแลระบบ)</span>
                <span className="font-mono text-slate-600">admin · PERSON_ID: SAM-P001</span>
              </button>
              <button
                type="button"
                onClick={() => fillQuickTestAccount('hrstaff', 'Staff@SamAtt2026')}
                className="text-left px-3 py-2 text-xs border border-slate-200 rounded-lg hover:bg-slate-50 flex items-center justify-between"
              >
                <span className="font-semibold text-blue-900">2. RESPONSIBLE_STAFF (เจ้าหน้าที่ HR)</span>
                <span className="font-mono text-slate-600">hrstaff · PERSON_ID: SAM-P002</span>
              </button>
              <button
                type="button"
                onClick={() => fillQuickTestAccount('user1003', 'User@SamAtt2026')}
                className="text-left px-3 py-2 text-xs border border-slate-200 rounded-lg hover:bg-slate-50 flex items-center justify-between"
              >
                <span className="font-semibold text-slate-800">3. GENERAL_USER (บุคลากรทั่วไป)</span>
                <span className="font-mono text-slate-600">user1003 · PERSON_ID: SAM-P003</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
