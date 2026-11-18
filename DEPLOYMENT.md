# Hướng dẫn Triển khai & Vận hành — Classroom 48

## 1. Kiến trúc thực tế đang chạy trong môi trường

- **Frontend**: React 19 + TypeScript (strict mode) + Vite + Tailwind CSS v4 + GSAP + React Router.
- **Backend**: Node.js + Express (`server.ts`, `server/app.ts`) chạy trên cổng `3000`, tích hợp WebSocket (`ws` tại `/ws`) cho đồng bộ thời gian thực.
- **Cơ sở dữ liệu mặc định (Self-contained SQLite WAL)**:
  - Sử dụng `better-sqlite3` ở chế độ `WAL` (`PRAGMA journal_mode = WAL`), bật `PRAGMA foreign_keys = ON`, và sử dụng transaction `BEGIN IMMEDIATE` để đảm bảo nguyên tử khi sinh viên chọn chỗ trống cuối cùng hoặc nộp phiếu chấm.
  - Phiên bản PostgreSQL/Supabase tương đương với Row-Level Security (RLS) và hàm `join_group_atomic` được cung cấp đầy đủ tại `supabase/migrations/001_postgresql_schema.sql`.
- **Xác thực & Bảo mật**:
  - Mật khẩu được băm bằng `crypto.scryptSync` với salt ngẫu nhiên 16-byte cho từng tài khoản và kiểm tra bằng `crypto.timingSafeEqual`.
  - Phiên đăng nhập sử dụng cookie `HttpOnly; SameSite=Lax` ký bằng HMAC-SHA256 và đối chiếu với bảng `sessions` trên máy chủ.
  - Giới hạn tốc độ (Rate Limiting) phía máy chủ cho đăng nhập, đặt lại mật khẩu, nhập mã phòng, chọn nhóm và gửi điểm.

## 2. Biến môi trường (`.env`)

| Biến | Bắt buộc | Mô tả |
|---|---|---|
| `PORT` | Không (mặc định `3000`) | Cổng lắng nghe HTTP & WebSocket |
| `SESSION_SECRET` | **Có (Production)** | Chuỗi bí mật ngẫu nhiên dùng ký cookie phiên |
| `DB_PATH` | Không (mặc định `./data/classroom48.db`) | Đường dẫn tệp cơ sở dữ liệu SQLite |
| `NODE_ENV` | `production` khi chạy thật | Bật phục vụ tĩnh thư mục `dist/` |

## 3. Tài khoản khởi tạo mặc định

Khi cơ sở dữ liệu trống, hệ thống tự động tạo dữ liệu lớp mẫu (`CNTT-K26`) gồm:
- **Super Admin**: `admin` / `Admin@1234`
- **Giáo viên**: `teacher01` / `Teacher@1234`
- **Giám khảo**: `grader01` / `Grader@1234`, `grader02` / `Grader@1234`
- **48 Học sinh**: `HS001` .. `HS048` / `Student@123` (đã chia sẵn 47 học sinh vào Nhóm 1–8; `HS048` chưa xếp nhóm để kiểm thử tự chọn chỗ trống cuối của Nhóm 8).

> **Lưu ý bảo mật**: Đổi mật khẩu các tài khoản quản trị và giáo viên ngay sau khi triển khai thực tế.

## 4. Lệnh kiểm tra, Build & Chạy Production

```bash
# 1. Cài đặt phụ thuộc
npm install

# 2. Chạy kiểm thử đơn vị + tích hợp đồng thời + bảo mật + xuất tệp
npm test

# 3. Kiểm tra TypeScript & Build frontend
npm run lint
npm run build

# 4. Chạy máy chủ production
NODE_ENV=production npm start
```

## 5. Sao lưu & Khôi phục Dữ liệu (SQLite WAL)

```bash
# Sao lưu an toàn khi máy chủ đang chạy (sử dụng sqlite3 .backup)
sqlite3 ./data/classroom48.db ".backup './backups/classroom48-$(date +%F-%H%M).db'"

# Khôi phục: dừng server, thay thế tệp DB chính và xóa tệp -wal/-shm cũ trước khi khởi động lại
```

## 6. Triển khai sang Supabase / PostgreSQL

1. Tạo dự án Supabase và chạy tệp migration `supabase/migrations/001_postgresql_schema.sql`.
2. Kích hoạt Supabase Realtime cho các bảng `rooms`, `groups`, `group_members`, `assessments`, `published_results`.
3. Đảm bảo mọi thao tác ghi nhạy cảm (tạo hàng loạt 48 tài khoản, đặt lại mật khẩu, chấm điểm & tính tổng) đều chạy qua Edge Function hoặc backend với `SUPABASE_SERVICE_ROLE_KEY` chỉ lưu trên server.
