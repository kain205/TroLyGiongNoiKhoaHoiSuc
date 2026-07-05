# Trợ lý Giọng nói Khoa Hồi sức — ICU Clinical Assistant (VNPT Hackathon)

Trợ lý cho bác sĩ ICU: hỏi bằng giọng nói, nhận tư vấn lâm sàng có đối chiếu guideline
trong vài giây. Bác sĩ chọn bệnh nhân (FHIR), hệ thống tính sẵn điểm lâm sàng + cảnh báo
an toàn thuốc (deterministic), rồi trả lời qua VNPT SmartBot và đọc to qua VNPT SmartVoice.

## Kiến trúc

```
frontend/  React + Vite (SPA)            ┐
server/    Node.js (Express)             ┴→ một Render Web Service
             ├─ logic deterministic: scoring, FHIR, safety/OpenFDA, drug-match
             └─ VNPT cloud: SmartBot (LLM/RAG) + SmartVoice (STT/TTS)
data/mock/ 18 FHIR R4 bundles (bệnh nhân test)
data/*.md  4 ICU guidelines → upload lên SmartBot knowledge base
docs/      tài liệu tích hợp VNPT (SmartBot + SmartVoice)
```

Toàn bộ ML (STT/TTS/LLM/RAG) chạy trên VNPT cloud → backend chỉ là lớp orchestration mỏng.
Phần an toàn lâm sàng (allergy/contraindication/interaction/clinical scores) chạy
**deterministic** ở `server/`, độc lập với LLM, và render TRƯỚC mọi câu trả lời.

## Chạy local

```bash
# 1. Backend
cd server && npm install && cp .env.example .env   # điền token VNPT — xem server/README.md
npm start                                            # http://localhost:8000

# 2. Frontend (terminal khác)
cd frontend && npm install --legacy-peer-deps
npm run dev                                          # http://localhost:5173
```

> Chi tiết token VNPT, endpoints, và cấu hình bot: **[server/README.md](server/README.md)**.

## Việc cần làm thủ công trên VNPT

1. Portal hackathon → **Quản lý token** → copy bộ key cho **SmartVoice** + **SmartBot**
2. SmartBot platform → tạo bot → bật **"Tri thức nâng cao"** → upload `data/*.md` (4 guideline)
3. Điền token vào `server/.env`

## Deploy

Repo có sẵn [`render.yaml`](render.yaml) để deploy frontend và backend chung một
Render Web Service. Express phục vụ bản build SPA, vì vậy production dùng cùng origin,
không cần đặt `VITE_API_BASE` hoặc CORS URL riêng.

### 1. Chuẩn bị

1. Commit và push phiên bản cần demo lên GitHub. Không commit `server/.env`.
2. Xác nhận bot SmartBot đã được upload 4 guideline, huấn luyện và bật **Tri thức nâng cao**.
3. Xác nhận token STT đã có quyền gọi API; token có giá trị nhưng chưa được cấp quyền vẫn trả 401.

### 2. Tạo dịch vụ từ Blueprint

1. Render Dashboard → **New** → **Blueprint** → kết nối repository này.
2. Render đọc `render.yaml` và tạo service `tro-ly-giong-noi-icu-demo` tại Singapore.
3. Nhập các secret được Render hỏi, lấy từ `server/.env`:
   - `STT_ACCESS_TOKEN`, `STT_TOKEN_ID`, `STT_TOKEN_KEY`
   - `TTS_ACCESS_TOKEN`, `TTS_TOKEN_ID`, `TTS_TOKEN_KEY`
   - `SB_BOT_ID`, `SB_ACCESS_TOKEN`, `SB_TOKEN_ID`, `SB_TOKEN_KEY`
4. Chờ health check `/api/health` đạt rồi mở URL `onrender.com` của service.

Blueprint dùng Node `24.14.1` từ `.node-version`, build React trước rồi cài dependency
production cho Express. Secret chỉ được khai báo `sync: false`; giá trị không nằm trong Git.

### 3. Kiểm tra sau deploy

```text
GET  /api/health
GET  /api/patients
GET  /api/patients/pt-001
POST /api/patients/pt-001/assessment
POST /api/patients/pt-001/chat/stream
POST /api/asr/transcribe
POST /api/tts/synthesize
```

Kiểm tra lần lượt chọn bệnh nhân, assessment, chat streaming, ghi âm STT và phát TTS.
Với chat lâm sàng, xác nhận câu trả lời có nguồn guideline và event SSE theo thứ tự
`meta → delta* → done`.

### 4. Vận hành bản demo

- Gói Render Free sleep sau 15 phút không có traffic; mở URL khoảng một phút trước khi trình diễn.
- Audit log và cache OpenFDA nằm trên filesystem tạm, có thể mất sau sleep, restart hoặc redeploy.
- URL không có đăng nhập và không rate limit theo cấu hình demo hiện tại; chỉ chia sẻ cho người thử.
- Nếu bản mới lỗi, vào **Render Dashboard → service → Events**, chọn deploy ổn định gần nhất và rollback.

Tài liệu tham khảo: [Render Blueprint](https://render.com/docs/infrastructure-as-code),
[Node version](https://render.com/docs/node-version),
[giới hạn gói Free](https://render.com/docs/free).

## Trạng thái migration

Repo này vừa được chuyển từ stack **Python (FastAPI + local ML)** sang **Node.js + VNPT**.
Backend Node tại `server/` đã thay thế hoàn toàn; calculator được verify **18/18 parity**
với bản Python gốc (`server/test/calculator.test.js`).

> **Thư mục `src/` (Python), `tests/`, `requirements.txt`, `requirement_analysis/` là LEGACY**
> — giữ tạm làm tham chiếu. Sẽ xóa sau khi tích hợp VNPT được kiểm thử end-to-end với token thật.
