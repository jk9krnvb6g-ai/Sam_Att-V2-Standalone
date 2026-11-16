/**
 * ============================================================================
 * จุดเริ่มต้นของแอปพลิเคชันฝั่งหน้าเว็บ (Frontend React Entry Point)
 * ไฟล์: frontend/src/main.tsx
 * ============================================================================
 * หน้าที่หลัก:
 * - โหลดไฟล์สไตล์หลัก (index.css) ซึ่งกำหนดชุดสี Soft Rose Enterprise และฟอนต์ภาษาไทย Sarabun
 * - นำคอมโพเนนต์หลัก <App /> ไปแสดงผล (Mount) ลงในแท็ก <div id="root"></div> ของไฟล์ index.html
 */
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(<App />);
