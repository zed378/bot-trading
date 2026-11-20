# Trading Agent Mpu Gandring — Docker dan PostgreSQL 18

## Menjalankan semuanya

Prasyarat: Docker Desktop aktif dengan Linux containers. Node.js, PostgreSQL, Python, Git, dan Chromium tidak perlu dipasang di host untuk menjalankan stack.

```powershell
docker compose --profile tools run --rm --no-deps init-secrets
docker compose up -d --build
```

Buka **http://127.0.0.1:8787**. Stack memulai desk dalam PAPER dengan Auto Trading off. Key exchange/provider tidak dimasukkan ke file Compose atau build image.

- `database`: PostgreSQL **18**, tidak memublikasikan port database ke host. Data berada di volume `postgres_data`.
- `app`: backend dan hasil build frontend Office. Proses aplikasi memakai user `node`; state non-database berada di volume `app_state`.
- `gateway`: Nginx dalam network namespace aplikasi, meneruskan HTTP/WebSocket ke backend loopback. Port publik hanya terikat ke **127.0.0.1:8787**. Backend tetap bind ke loopback, termasuk pada LIVE.
- Pemantau SL dapat dijalankan dari panel Indodax; tidak membutuhkan proses host. CLI alternatif juga dijalankan di container.

Pengaturan desk tersimpan di skema PostgreSQL `desk`. Referensi SL, hasil order jual dan kredensial Indodax tersimpan di skema `indodax_stops`. Kedua skema terpisah agar saldo IDR dan inventori spot tidak dianggap sebagai ledger entry USDT.

## Kredensial dashboard

Pilih **Indodax** pada menu alat Office untuk memasukkan API Key dan API Secret melalui input password. **Simpan terenkripsi** hanya menyimpan kredensial. **Periksa izin key** mengirim pembacaan akun; tidak mengirim order. Trading harus diizinkan, sedangkan penarikan crypto dan fiat harus terbukti nonaktif.

Pilih **AI** untuk form provider terpisah:

- OpenAI compatible: Base URL, nama model, API key, serta pilihan **Chat Completions** atau **Responses**.
- Anthropic: Base URL, nama model, API key, menggunakan **Messages API**.

Base URL OpenAI-compatible umumnya berakhir `/v1`; integrasi menambahkan `/chat/completions` atau `/responses`. Untuk Anthropic, gunakan host atau host dengan `/v1`; integrasi menambahkan endpoint Messages sekali. Nama model diisi sesuai provider Anda. Server tidak menebak dukungan model. **Uji model** memakai token provider dan hanya dilakukan saat tombol diklik. **Gunakan untuk 6 agen** menerapkan model ke enam agen melalui versi pengaturan yang sudah ada; tidak menyalakan Auto Trading.

API key dan secret dari kedua form disimpan di PostgreSQL dengan **AES-256-GCM**, nonce acak, authentication tag, serta associated data yang mengikat konteks dan metadata endpoint. Perubahan ciphertext atau pengalihan endpoint langsung di database menyebabkan autentikasi dekripsi gagal. API GET hanya mengembalikan status tersimpan; tidak mengembalikan plaintext, ciphertext, atau potongan key. Secret hanya didekripsi di backend saat diperlukan, dan tidak disalin ke `.env` oleh form baru ini.

Kunci utama berasal dari Docker secret `indodax_master_key`, terpisah dari password PostgreSQL. Folder `.secrets/` bersifat lokal, diabaikan Git dan build context. File rahasia dipertahankan saat `init-secrets` dijalankan ulang; nilainya tidak dicetak. Parent directory dibatasi ke owner; file diberi hak baca yang memungkinkan Docker Compose memasangnya ke proses non-root, dan mount secret di container bersifat read-only.

**Backup `.secrets/` secara aman bersama backup PostgreSQL.** Database saja tidak cukup untuk memulihkan kredensial terenkripsi. Jangan menghapus atau mengganti master key ketika masih ada kredensial yang dibutuhkannya. Jangan mengirim isi file secret ke chat atau log.

## Impor SQLite lama

Runtime produksi tidak memakai SQLite dan tidak beralih otomatis ke SQLite ketika PostgreSQL gagal. SQLite hanya dibaca oleh alat migrasi; adapter SQLite juga dipertahankan khusus untuk fixture pengujian lama.

1. Hentikan runtime lama dan pemantau SL. Salin file SQLite beserta `-wal`/`-shm` jika ada ke backup aman. Tidak perlu menghapus sumber asli.
2. Jalankan database Compose dan buat image baru.
3. Lakukan dry run sebelum import:

```powershell
docker compose --profile tools run --rm migrate
```

4. Jika sumber benar dan target **masih kosong**, lakukan import:

```powershell
docker compose --profile tools run --rm migrate node /app/dist/server/cli/migrate-postgres.js --source /legacy/rebirth/runtime.sqlite --schema desk --apply
```

Untuk file SL lama, jalankan perintah yang sama dengan `--source /legacy/indodax-stops.sqlite --schema indodax_stops`. Mount sumber `/legacy` read-only. Jangan menyalakan Office sebelum import apabila ingin memakai sumber lama: Office membuat pengaturan awal, sehingga target tidak lagi kosong.

Import menyalin tabel yang dikenal dalam satu transaksi, memverifikasi nilai dan jumlah baris, mempertahankan decimal string/identitas order/digest event, dan melanjutkan identity sequence event. Target tidak kosong ditolak; data tidak digabungkan atau ditimpa. Sumber SQLite tidak diubah. Jika gagal, transaksi target di-rollback. Data `.env` lama tidak diimpor sebagai plaintext credential: masukkan kembali kredensial melalui form terenkripsi.

## Operasi dan pengujian

```powershell
docker compose ps
docker compose logs --tail 50 app
docker compose --profile test run --rm test npm test
docker compose exec app node /app/dist/server/cli/indodax-stops.js status
docker compose stop
```

Profile `test` mempunyai PostgreSQL 18 terpisah dengan penyimpanan sementara. Pengujian integrasi PostgreSQL membuat skema `mpu_test_*` dalam database `mpu_test`; cleanup menolak database di luar database test itu. Pengujian konektor memakai mock API, bukan order riil. **Jangan memakai `down -v` pada stack berisi data yang ingin dipertahankan.**

API/provider custom yang berjalan di host dapat memakai `host.docker.internal`, misalnya `http://host.docker.internal:1234/v1`. HTTPS wajib untuk endpoint non-lokal. Base URL dengan username/password atau query ditolak, dan redirect request berkredensial tidak diikuti.

SQLite lama dapat di-rollback hanya sebagai arsip, bukan dengan menjalankannya paralel dengan runtime PostgreSQL. Jangan menghidupkan dua ledger untuk akun yang sama; order yang sudah dikirim harus direkonsiliasi sebelum pemulihan backup.
