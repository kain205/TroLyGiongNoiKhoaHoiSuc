# Đồng bộ NLU và knowledge card trên VNPT SmartBot

Backend đã chặn câu ngoài phạm vi, lời chào và yêu cầu vancomycin không đủ bằng
chứng. Các bước dưới đây vẫn cần thực hiện trên portal để SmartBot trả đúng intent
và đúng nhóm tài liệu.

## 1. Đồng bộ câu mẫu

1. Mở `data/smartbot_nlu_intents.json`.
2. Tạo hoặc cập nhật các intent `sepsis_ssc`, `phan_ve`, `ards`, `aki_lieu`,
   `xin_chao` và `fallback`.
3. Nhập các câu trong từng mảng tương ứng. Không nhập
   `scripts/clinical-regression-cases.json`; đây là tập đánh giá giữ lại.
4. Nhấn **Huấn luyện** sau khi hoàn tất.

## 2. Giới hạn knowledge card

Gắn thẻ tri thức của từng kịch bản vào đúng nhóm tài liệu:

| Intent | Tài liệu được phép |
|---|---|
| `sepsis_ssc` | `ssc_2021.docx` |
| `phan_ve` | `tt51_phan_ve.docx` |
| `ards` | `icu_2015.docx`, `ssc_2021.docx` |
| `aki_lieu` | `icu_2015.docx` |

Kịch bản `fallback` phải trả thông báo ngoài phạm vi hoặc chuyển giao, không gắn
thẻ tri thức sinh câu trả lời tự do. `xin_chao` chỉ trả lời chào và không gắn nguồn.

## 3. Kiểm tra sau huấn luyện

1. Trên màn hình thử bot, xác nhận câu paraphrase ARDS được gán `ards`, không còn
   sang `aki_lieu`.
2. Xác nhận câu về thuốc vận mạch trong sốc tim đi vào `fallback`.
3. Khởi động backend mới và chạy:

   ```powershell
   cd server
   npm run eval:clinical
   ```

Kết quả đạt khi 10/10 dòng `pass=true`; bảy câu có trả lời lâm sàng phải có
1–3 nguồn đã xác minh, còn AKI định lượng, ngoài phạm vi và lời chào có 0 nguồn.
