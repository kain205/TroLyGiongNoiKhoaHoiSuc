# Trợ lý Giọng nói Khoa Hồi sức — ICU Clinical Assistant (VNPT Hackathon)

Trợ lý cho bác sĩ ICU: hỏi bằng giọng nói, nhận tư vấn lâm sàng có đối chiếu guideline
trong vài giây. Bác sĩ chọn bệnh nhân (FHIR), hệ thống tính sẵn điểm lâm sàng + cảnh báo
an toàn thuốc (deterministic), rồi trả lời qua VNPT SmartBot và đọc to qua VNPT SmartVoice.

## Kiến trúc

```
frontend/  React + Vite (SPA)            → Vercel/Netlify
server/    Node.js (Express)             → Render/Railway
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

- **Frontend** (Vercel/Netlify): build `frontend/`, set `VITE_API_BASE` = URL backend
- **Backend** (Render/Railway): chạy `server/` (long-running, hợp SSE streaming), set các biến VNPT

## Trạng thái migration

Repo này vừa được chuyển từ stack **Python (FastAPI + local ML)** sang **Node.js + VNPT**.
Backend Node tại `server/` đã thay thế hoàn toàn; calculator được verify **18/18 parity**
với bản Python gốc (`server/test/calculator.test.js`).

> **Thư mục `src/` (Python), `tests/`, `requirements.txt`, `requirement_analysis/` là LEGACY**
> — giữ tạm làm tham chiếu. Sẽ xóa sau khi tích hợp VNPT được kiểm thử end-to-end với token thật.
