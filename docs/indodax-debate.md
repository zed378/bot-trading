# Panduan Debat Spot Indodax

Dokumen ini menjelaskan cara kerja siklus debat enam agen untuk pasangan spot Indodax di Trading Agent Mpu Gandring.

## 1. Sumber Konteks Tunggal

Setiap permintaan debat (dari tombol **Start debate**, perintah chat `analyze <PAIR>`, maupun sesi **PAPER agent**) melewati pembangun konteks yang sama:

1. **Validasi simbol** (`resolveIndodaxSymbol`): mencocokkan input seperti `BTCIDR`, `btc_idr`, atau `BTCUSDT` ke daftar `/api/pairs` Indodax dan menolak pasangan yang tidak terdaftar, maintenance, atau suspended.
2. **Pembangun konteks** (`buildIndodaxContext`): mengambil ticker publik, bid/ask, fee taker, aturan minimum order, dan candle tertutup **4h** atau **1d**, lalu menghitung indikator (`EMA`, `RSI`, `ATR`), struktur **SMC** (`advisory.structure`), dan parameter KORO (`indodax-params`).
3. **Kendala tetap**: hanya **spot long-only** (`OPEN_LONG`, `HOLD`, `CLOSE`), tanpa short, tanpa leverage, tanpa limit GTC, serta pemisahan ketat antara quote `IDR` dan `USDT`.

## 2. Alur Siklus Enam Peran

1. **Observe**: `Market Analyst`, `Research Analyst`, dan `Strategist` membaca ringkasan pasar Indodax secara berurutan.
2. **Challenge**: fase sanggahan untuk menguji skenario entry, invalidasi, dan argumen tandingan.
3. **Final Synthesis**: `Desk Lead`, `Risk Manager`, dan `Execution Trader` menyusun keputusan akhir.
4. **Gerbang Verdict Spot** (`toIndodaxVerdict`): memastikan keluaran akhir hanya berupa `OPEN_LONG`, `HOLD`, atau `CLOSE`.
5. **Jev (Opsional)**: bila diaktifkan lewat OpenRouter, Jev hanya memberi konteks tambahan (`shadow` atau `assist`) dan tidak pernah menempatkan order atau melewati gerbang Risk.

## 3. Hasil Debat vs Sesi PAPER

- **Debat dari Office / `analyze BTCIDR`**: hanya menyimpan saran di panel **Verdicts** dan log ruang rapat; tidak membuka posisi simulasi maupun order riil.
- **Sesi PAPER agent** (panel **Indodax**): mensimulasikan pembelian dan penjualan spot pada harga bid/ask publik Indodax dengan pelacakan fee taker dan batas rugi harian.
- **Mode LIVE**: hanya berlaku untuk pemantau stop-loss (`BOT_MANAGED`) pada aset yang sudah dimiliki Owner, bukan untuk entry otomatis oleh agen.

## 4. Ketahanan Penyedia AI

Satu siklus penuh memanggil sekitar 9 tugas peran ke penyedia AI. Untuk menghadapi batas laju (`HTTP 429`) dan kepadatan kapasitas sementara (`HTTP 503`):

- Setiap peran mencoba hingga 4 kali untuk error kapasitas/rate-limit (`429`/`503`/`502`), menghormati header `Retry-After` jika tersedia, atau memakai backoff eksponensial.
- Jika semua percobaan gagal, siklus berhenti secara jujur dengan status `INCOMPLETE` dan menampilkan alasan penolakan penyedia serta jumlah panggilan (`providerCalls`) pada diagnostik PAPER.
