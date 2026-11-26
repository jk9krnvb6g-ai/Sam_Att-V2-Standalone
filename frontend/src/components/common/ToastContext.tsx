/**
 * ============================================================================
 * ระบบแจ้งเตือนแบบ Floating Toast กลางของแอปพลิเคชัน (Global HIS Toast Context)
 * ไฟล์: frontend/src/components/common/ToastContext.tsx
 * ============================================================================
 * - ใช้งานได้ทุกหน้าจอผ่าน useToast()
 * - Success ปิดอัตโนมัติใน 4000ms (ตามมาตรฐาน alert system)
 * - Error แสดงชัดเจนจนกว่าผู้ใช้จะกดปิดเอง และรองรับ requestId
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { FloatingToastStack, type FloatingToastData } from './SharedComponents.tsx';

export interface ToastInput {
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message?: string;
  requestId?: string | null;
  autoDismissMs?: number;
}

interface ToastContextValue {
  showToast: (input: ToastInput) => string;
  showSuccess: (title: string, message?: string) => string;
  showError: (title: string, message?: string, requestId?: string | null) => string;
  showWarning: (title: string, message?: string) => string;
  showInfo: (title: string, message?: string) => string;
  success: (title: string, message?: string) => string;
  error: (title: string, message?: string, requestId?: string | null) => string;
  warning: (title: string, message?: string) => string;
  info: (title: string, message?: string) => string;
  dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<FloatingToastData[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismissToast = useCallback((id: string) => {
    const existingTimer = timersRef.current.get(id);
    if (existingTimer) {
      clearTimeout(existingTimer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => clearTimeout(timer));
      timersRef.current.clear();
    };
  }, []);

  const showToast = useCallback(
    (input: ToastInput): string => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const variant: FloatingToastData['variant'] =
        input.type === 'error'
          ? 'error'
          : input.type === 'warning'
            ? 'warning'
            : 'success';

      const autoDismissMs =
        input.autoDismissMs !== undefined
          ? input.autoDismissMs
          : input.type === 'success'
            ? 4000
            : input.type === 'info'
              ? 4500
              : input.type === 'warning'
                ? 6500
                : 0;

      setToasts((prev) => [
        ...prev.slice(-3),
        {
          id,
          variant,
          message: input.title,
          detail: input.message,
          requestId: input.requestId || undefined,
        },
      ]);

      if (autoDismissMs > 0) {
        const timer = setTimeout(() => {
          dismissToast(id);
        }, autoDismissMs);
        timersRef.current.set(id, timer);
      }

      return id;
    },
    [dismissToast]
  );

  const showSuccess = useCallback(
    (title: string, message?: string) =>
      showToast({ type: 'success', title, message, autoDismissMs: 4000 }),
    [showToast]
  );

  const showError = useCallback(
    (title: string, message?: string, requestId?: string | null) =>
      showToast({ type: 'error', title, message, requestId, autoDismissMs: 0 }),
    [showToast]
  );

  const showWarning = useCallback(
    (title: string, message?: string) =>
      showToast({ type: 'warning', title, message, autoDismissMs: 6500 }),
    [showToast]
  );

  const showInfo = useCallback(
    (title: string, message?: string) =>
      showToast({ type: 'info', title, message, autoDismissMs: 4500 }),
    [showToast]
  );

  const contextValue = useMemo<ToastContextValue>(
    () => ({
      showToast,
      showSuccess,
      showError,
      showWarning,
      showInfo,
      success: showSuccess,
      error: showError,
      warning: showWarning,
      info: showInfo,
      dismissToast,
    }),
    [showToast, showSuccess, showError, showWarning, showInfo, dismissToast]
  );

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <FloatingToastStack toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  );
}

const NOOP_TOAST_CONTEXT: ToastContextValue = {
  showToast: () => '',
  showSuccess: () => '',
  showError: () => '',
  showWarning: () => '',
  showInfo: () => '',
  success: () => '',
  error: () => '',
  warning: () => '',
  info: () => '',
  dismissToast: () => {},
};

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  return ctx || NOOP_TOAST_CONTEXT;
}
