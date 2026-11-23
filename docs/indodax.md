# Trading Agent Mpu Gandring — Indodax

## Cakupan saat ini

Integrasi ini menyediakan **analisis data pasar spot publik Indodax** lewat Office dan CLI, tanpa API key. Harga, bid/ask, metadata minimum order, dan candle memakai pasangan Indodax yang sebenarnya. Pasangan IDR dan USDT tidak dikonversi atau dicampur dengan saldo desk.

**Entry Indodax dari desk utama belum didukung.** Panel kini juga memiliki form kredensial terenkripsi dan pemantau SL untuk aset spot yang didaftarkan. Lihat [SL yang dijalankan bot](indodax-bot-stops.md) dan [Docker/PostgreSQL 18](docker-postgres.md). Memilih panel tidak mengubah venue, strategi, mode, watchlist, atau Auto Trading desk utama. Jangan memilih `EXCHANGE=indodax` atau `MARKET_SOURCE=indodax`: kedua pengaturan tersebut belum didukung oleh runtime entry utama.

## Menggunakan Office

1. Jalankan `npm.cmd run dev` di Windows (`npm run dev` pada shell lain).
2. Buka `http://127.0.0.1:5173`, lalu pilih **Indodax** di menu alat Office.
3. Pilih pasangan dan timeframe **4h** atau **1d**. Panel menampilkan mata uang pasangan di setiap harga, grafik candle tertutup, EMA dan RSI.
4. Klik **Muat ulang / Refresh** untuk memperbarui observasi. Panel tidak melakukan polling di latar belakang. Respons publik disimpan sementara untuk mengurangi permintaan API; waktu observasi tetap mengikuti data yang diambil.

Office yang dijalankan dari hasil build memakai port backend `8787`. Endpoint ini hanya bisa diakses dari komputer lokal dengan origin lokal, mengikuti kebijakan Office.

## Menggunakan CLI

```powershell
npm.cmd run indodax -- pairs
npm.cmd run indodax -- analyze BTCIDR 4h
npm.cmd run indodax -- analyze ETHIDR 1d
```

CLI mencetak JSON. Tidak membaca `.env`, meminta key, mengaktifkan Auto Trading, atau menginisialisasi runtime trading. Kegagalan menghasilkan exit code `2`. Perintah ini membutuhkan akses jaringan publik; pengujian menggunakan fixture lokal.

## Endpoint Office

- `GET /api/indodax/pairs`
- `GET /api/indodax/market?symbol=BTCIDR&tf=4h`

Respons pasar memuat `venue=indodax`, `marketType=spot`, `access=public-read-only`, `executionSupported=false`, mata uang quote, decimal string, waktu observasi, dan sumber endpoint. Angka untuk grafik dan indikator dihitung dari candle yang sama. Indikator memakai utilitas EMA/RSI Trading Agent Mpu Gandring dan tidak mengeluarkan instruksi order.

Sumber publik yang digunakan:

- `https://indodax.com/api/pairs`: nama pasangan, mata uang, minimum, status maintenance/suspended.
- `https://api.indodax.com/api/v2/ticker/price`: harga terakhir.
- `https://api.indodax.com/api/v2/ticker/bookTicker`: bid/ask.
- `https://indodax.com/tradingview/history_v2`: candle, `tf=240` atau `tf=1D`, waktu Unix dalam detik.

Implementasi menolak pasangan tidak terdaftar, status maintenance/suspended, respons rusak, simbol tidak cocok, candle duplikat, data candle basi, dan OHLC tidak valid. Candle yang belum selesai tidak dipakai. Kegagalan tidak diganti dengan data sample atau harga venue lain. Permintaan memiliki timeout, cache, penggabungan permintaan serentak, anggaran per host, dan jeda setelah HTTP 429.

## Batasan trading

Owner menyetujui pengecualian khusus untuk SL Indodax yang disimpan di database dan dieksekusi bot. Perlindungan ini ditandai `BOT_MANAGED`, bukan exchange-verified. Jalur order entry utama dan kewajiban stop exchange untuk venue lain tetap berlaku. Detail kegagalan, konfirmasi LIVE, heartbeat, dan pemulihan order dijelaskan pada panduan SL.

## Parameter atlas KORO

Sembilan gambar di `../stock-recommendation/param` (KORO Math Atlas) berasal dari bot futures Binance. Indodax hanya spot, tanpa short, leverage, funding, atau open interest, dan hanya menyediakan candle 4h/1d (tanpa 5m). Hanya bagian yang bermakna untuk spot long-only dimasukkan ke `server/market/indodax-params.ts`. Semuanya **konteks untuk agen PAPER**; tidak mengubah ukuran order, tidak melonggarkan guard, dan tidak menyentuh jalur LIVE.

| Atlas | Status | Catatan |
| --- | --- | --- |
| 01 Statistik episode (WR, RR, PF, expectancy, Kelly, MDD, recovery) | Dimasukkan | Dari episode PAPER yang tertutup, sudah termasuk fee. Panel menandai sampel di bawah 30 sebagai bukan bukti edge. Kelly hanya diagnostik. |
| 02 Karakter koin (ATRP, ρ₁, VR, ER, z4, z24, zero rate) | Dimasukkan | Dihitung per pasangan pada candle 4h tertutup (N=42, W=180, q=6). Cascade persentil lintas universe, Amihud, dan V24 tidak dimasukkan: satuan `Volume` candle Indodax tidak terdokumentasi dan universe penuh melampaui anggaran request publik. |
| 03 Routing OBV | Sebagian | Hanya cabang LONG (TF_LONG, MR_LONG) dengan timing EMA21/ATR14. OI dan funding tidak ada di spot; cabang short dikembalikan sebagai `NO_SPOT_ACTION`. Jendela arah harga tidak ditentukan atlas; dipakai 48 bar yang sama dengan OBV. |
| 04 Unit order dari Kelly bergulir | Tidak | Ukuran entry tetap setengah kas simulasi. Unit `$5,5` adalah notional futures. |
| 05 ADD adaptif dan recovery | Hanya gerbang fee | Entry ditolak bila take profit tidak melewati fee round-trip + 0,1% dari harga entry. ADD tidak ada karena agen PAPER satu posisi per sesi. |
| 06 Entry lottery dengan memori | Tidak | Menambah keacakan pada keputusan agen tanpa bukti manfaat untuk spot. |
| 07 Rem outlier dan momentum portofolio | Tidak | Butuh basket ≥5 posisi. |
| 08 Halving, net leverage, margin | Tidak | Khusus margin futures. |
| 09 Acuan saldo, halt 7%, jam WIB | Tidak | Batas rugi harian Desk (default 3%) sudah lebih ketat dan menghentikan siklus. Slot jam WIB adalah jadwal bot referensi, bukan aturan spot. |

Hasil modul ini muncul di `marketSummary.advisory` untuk enam agen dan di `stats` pada `GET /api/indodax/paper-agent`. Rumus diuji dengan contoh angka dari atlas 01; angka itu bukan bukti profitabilitas strategi di Indodax.

## Referensi dan verifikasi

Referensi lokal yang dibaca adalah `../stock-recommendation/src/aidss_trader/connector/client.py` serta dokumen integrasi `03-INDODAX-OVERVIEW.md` dan `05-INDODAX-MARKET-DATA.md`. Yang diadaptasi hanya kontrak endpoint, format simbol dan respons publik. Strategi, Risk Engine, state machine order, dan logika keputusan proyek referensi tidak diimpor atau disalin.

Konektor dan endpoint diuji dengan fixture serta server HTTP lokal. Tidak ada signed request, key akun, order, atau transaksi Indodax yang digunakan dalam pengujian. Kesesuaian respons produksi belum diverifikasi pada pengerjaan ini; keberhasilan fixture bukan bukti koneksi akun atau profitabilitas.
