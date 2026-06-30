# ICU Assistant — Node.js Backend (VNPT SmartBot + SmartVoice)

Lớp orchestration mỏng cho trợ lý lâm sàng ICU. Logic lâm sàng deterministic
(clinical scoring, FHIR parsing, safety/allergy/OpenFDA, drug fuzzy-match) chạy
tại đây; STT/TTS/LLM/RAG giao cho VNPT cloud.

## Yêu cầu

- Node.js ≥ 18 (dùng native `fetch` / `FormData`)
- Token VNPT (xem bên dưới)

## Cài đặt & chạy

```bash
cd server
npm install
cp .env.example .env      # rồi điền token (xem mục VNPT)
npm start                 # http://localhost:8000
npm test                  # vitest — parity với calculator Python
```

## Cấu hình VNPT (`.env`)

Lấy token từ **portal hackathon VNPT → tab "Quản lý token"** (mỗi sản phẩm 1 bộ key
gồm `access_token`, `Token-id`, `Token-key`):

| Biến | Ý nghĩa |
|---|---|
| `SV_ACCESS_TOKEN` / `SV_TOKEN_ID` / `SV_TOKEN_KEY` | SmartVoice (STT + TTS) — dán token KHÔNG kèm "Bearer " |
| `SB_ACCESS_TOKEN` / `SB_TOKEN_ID` / `SB_TOKEN_KEY` | SmartBot (LLM/RAG) — bộ key riêng |
| `SB_BOT_ID` | bot_id sau khi tạo bot trên SmartBot platform |
| `TTS_REGION` / `TTS_MODEL` | giọng đọc TTS (mặc định `female_north` / `news`) |

**Trên SmartBot platform:** tạo bot → bật **"Tri thức nâng cao"** (bắt buộc, để
`system_prompt` có hiệu lực) → upload 4 guideline trong `data/*.md` vào knowledge base.

## API

| Method | Path | Mô tả |
|---|---|---|
| GET | `/api/health` | health check |
| GET | `/api/patients` | danh sách bệnh nhân (demographics) |
| GET | `/api/patients/:pid` | hồ sơ đầy đủ + clinical scores |
| POST | `/api/patients/:pid/assessment` | đánh giá ban đầu (deterministic, no LLM) |
| POST | `/api/patients/:pid/chat` | `{query}` → SmartBot trả lời + safety alerts render đầu |
| POST | `/api/asr/transcribe` | WAV (PCM16 mono) → SmartVoice STT → `{text, suggestions}` |
| POST | `/api/tts/synthesize` | `{text}` → SmartVoice TTS → `{audio_url}` |

## Kiến trúc

```
routes/ → patientStore + rag/queryRouter + safety/* (deterministic)
        → vnpt/smartbot (LLM/RAG) + vnpt/smartvoice (STT/TTS)
```

Tài liệu API VNPT: `../docs/smartbot_docs/`, `../docs/smartvoice_docs/`.
