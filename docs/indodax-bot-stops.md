# Trading Agent Mpu Gandring — SL yang dijalankan bot

## Keputusan Owner

Owner menyetujui referensi SL disimpan dalam database dan bot menjual aset ketika harga menyentuh SL, dengan konsekuensi ketergantungan pada bot/komputer/jaringan/API. Pengecualian ini khusus untuk **pemantau penutupan spot Indodax**. Ini bukan bukti stop order tersimpan di exchange. Guard exchange-side stop untuk venue/jalur entry lain tetap berlaku.

Strategi, Risk Engine dan logika keputusan dari proyek referensi tidak digunakan. Kontrak HTTP Indodax menjadi referensi integrasi; penutupan memakai `ExecutionGateway.close` Trading Agent Mpu Gandring yang sudah ada.

## Cakupan

Pemantau mengadopsi jumlah aset yang **sudah dimiliki**, lalu menyimpan `stop_price` sebagai decimal string di `managed_positions`. Tabel `indodax_bot_stops` menyimpan status dan jejak upaya exit, bukan duplikat nilai SL. Data berada dalam skema PostgreSQL `indodax_stops`, terpisah dari ledger entry USDT. PAPER memakai identitas akun lokal; LIVE memakai hash identitas akun yang diverifikasi.

Pemantau tidak membeli, membuka short, memakai leverage, menentukan ukuran baru, atau mengaktifkan Auto Trading. Harga entry yang diisi adalah referensi cost basis Owner, bukan fill yang diklaim dari exchange. Entry Indodax otomatis dari enam agen belum tersedia dalam jalur desk utama.

## Office

1. Buka panel **Indodax**, masukkan key lewat form tersamar, lalu **Simpan terenkripsi**.
2. **Periksa izin key** sebelum memakai LIVE. Trading harus on, penarikan crypto dan fiat harus off. Key dengan izin tidak diketahui ditolak.
3. Mulai dengan **PAPER**. Pilih pasangan, isi jumlah aset, harga entry referensi, dan harga SL dalam mata uang pasangan.
4. **Simpan / perbarui SL**, kemudian **Jalankan pemantau SL**. Nilai tersimpan saja tidak berarti pemantau sudah berjalan.
5. Untuk LIVE, pilih mode LIVE dan ketik sendiri `I understand LIVE trades real money`. Pemantau ini terpisah dari mode desk utama dan ditandai LIVE pada panelnya.

LIVE menjual aset riil secara otomatis, dapat menimbulkan kerugian, dan bukan nasihat keuangan. Pasangan IDR memakai harga IDR, bukan konversi diam-diam ke USDT. Jumlah tidak dibulatkan naik. Aset yang sama tidak dapat diadopsi ke dua pasangan quote aktif sekaligus.

**Hentikan pemantau SL** menghentikan eksekusi otomatis tetapi mempertahankan referensi di database. **Nonaktifkan SL** menonaktifkan satu referensi; tidak mengirim penjualan dan tidak mengklaim aset wallet sudah terjual. Order exit yang masih belum pasti harus direkonsiliasi dahulu. Key LIVE hanya dapat diganti setelah pemantau dihentikan; proses CLI juga harus dihentikan.

## CLI dalam container

```powershell
docker compose exec app node /app/dist/server/cli/indodax-stops.js --help
docker compose exec app node /app/dist/server/cli/indodax-stops.js status
```

Perintah yang tersedia adalah `arm <PAIR> --qty <JUMLAH> --entry <HARGA> --stop <HARGA>`, `watch`, `status`, `disarm <PAIR>`, dan `doctor --mode LIVE`. Default PAPER. Mutasi/pemantauan LIVE juga membutuhkan `--mode LIVE --confirm-live "I understand LIVE trades real money"` yang diketik Owner. Kredensial dibaca dari vault terenkripsi yang sama dengan dashboard; tidak lewat flag atau output.

Gunakan satu pemantau per akun. Office atau CLI dapat memuat ulang referensi setelah restart, tetapi proses pemantau harus dijalankan kembali secara eksplisit. Authority epoch mencegah pemantau lama melanjutkan setelah diambil alih. Mode PAPER tidak mengirim private order atau memakai saldo akun riil.

## Perilaku stop dan pemulihan

- Harga terakhir yang teramati `<= SL` melatch trigger; pemulihan harga tidak menghapus upaya exit yang sudah terpicu.
- Referensi trigger dan client order id ditulis sebelum pengiriman melalui gateway. Satu intent tidak dikirim dua kali.
- Respons POST diterima berarti **ACCEPTED**, bukan FILLED. Konfirmasi diperoleh dari lookup order native.
- Timeout, order belum terlihat, atau crash sesudah journal menjadi **UNKNOWN**. Bot memeriksa client order id yang sama; tidak membuat order pengganti secara buta.
- Partial fill dikreditkan secara kumulatif dan idempoten. Sisa jumlah tetap terlihat. Order yang dibatalkan/ditolak memerlukan pemeriksaan dan rearm eksplisit.
- Gangguan quote tidak menghapus SL; pembacaan dapat pulih. Kekurangan saldo, pergantian akun, metadata minimum hilang, atau kesalahan database memblokir pengiriman dan menghasilkan status yang perlu perhatian.
- Kill switch menjeda pemantau dan diperiksa lagi sebelum write. Menghentikan backend, container, atau komputer juga menonaktifkan eksekusi SL.

Ticker publik tidak menyediakan timestamp harga asal; waktu yang ditampilkan adalah waktu observasi respons lokal. Respons lambat/basi secara lokal ditolak, tetapi indikator heartbeat maupun database tidak membuktikan feed exchange selalu bergerak atau menjamin eksekusi. Harga jual dapat melewati SL, dan minimum exchange/dust/izin/likuiditas dapat menghalangi penjualan. Pantau `UNKNOWN`, `ERROR`, pesan kegagalan, serta heartbeat yang lama.

Belum ada pembuktian signed POST dengan akun riil dalam pengerjaan ini. Test memakai mock dan database PostgreSQL 18 terisolasi; tidak ada mode LIVE atau order riil yang diaktifkan oleh agen pengembang.
