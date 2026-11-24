# Rancangan: proyek khusus Indodax

Status: usulan, menunggu persetujuan Owner. Belum ada kode yang diubah.
Tanggal: 2026-11-24.
Dokumen pasangan: [rencana tugas](../plans/2026-11-24-indodax-only-plan.md).

## 1. Tujuan

Proyek ini diturunkan dari Trading Agent Mpu Gandring v0.0.0.4.32, desk agen untuk perpetual futures di banyak venue. Owner hanya membutuhkan Indodax. Perombakan ini membuat Indodax satu-satunya venue, sehingga:

1. Saat Owner meminta agen berdebat, konteksnya sudah pasti Indodax spot. Tidak ada pilihan venue, tidak ada simbol Bybit, tidak ada leverage, funding, atau short di prompt maupun di UI.
2. Kode, dependensi, dokumen, dan tes yang tidak dipakai Indodax dihapus, bukan dinonaktifkan.
3. Semua pengaman yang berlaku untuk Indodax tetap ada dan tidak dilonggarkan.

## 2. Kondisi sekarang

Angka di bawah diambil dari repo pada commit `3904fed`.

| Hal | Temuan |
| --- | --- |
| Ukuran | sekitar 68.000 baris TypeScript di `server`, `web/src`, dan `cli`; 255 file di `server`; 153 entri di `tests`; 98 file di `docs` |
| Titik masuk | `server/index.ts` memuat `server/v2/runtime.ts` (222 KB). Jalur v2 inilah yang hidup |
| Jalur lama | `server/desk.ts` (199 KB), `server/app.ts`, `server/runtime.ts`, `server/auto.ts` dan modul sekitarnya. `server/v2/runtime.ts` tidak mengimpor `desk.ts`, tetapi `server/setup/routes.ts`, `server/research/routes.ts`, `server/channels/*`, `server/reports.ts`, `server/scan.ts` dan `cli/debate.ts` masih mengimpornya. Apakah semuanya terputus dari jalur v2 harus dibuktikan dengan graf impor (tugas 0.2) |
| Venue | 8 adaptor di `server/exchange/` dan 8 adaptor di `server/v2/execution/adapters/`: aster, binance, bybit, dydx, hyperliquid, okx, orderly, paradex |
| Data pasar utama | `BybitMarketHub` (`server/v2/market/bybit.ts`) memberi data untuk siklus debat. Simbol cadangan di `triggerCycle` adalah `BTCUSDT` |
| Debat dari Office | `triggerCycle` di `server/v2/runtime.ts` berjalan di atas posisi perpetual, slot N, saldo USDT, daftar pantau, dan batas rugi harian dalam USDT |
| Indodax | Tambahan di samping jalur utama: data publik (`server/market/indodax.ts`), parameter KORO (`indodax-params.ts`), sesi PAPER enam agen (`server/v2/api/indodax-paper.ts`), pemantau SL (`server/v2/execution/indodax-stops.ts`), form kredensial terenkripsi, dua CLI |
| Siklus agen Indodax | `runtime.runIndodaxPaperCycle` memakai `cycleRunner` yang sama dengan debat utama, dengan `marketSummary` dari klien publik Indodax. Jadi mesin debatnya sudah bisa dipakai ulang |
| Dependensi berat non-Indodax | `viem`, `starknet`, `@noble/curves`, `@scure/base`, `@msgpack/msgpack`, `ws` untuk wallet dan DEX; `playwright-core` untuk riset peramban; `@libsql/client` untuk penyimpanan SQLite |
| Layanan Docker | `database` (PostgreSQL 18), `app`, `gateway` (nginx), `migrate`, `test` |
| Penyedia model | Profil `openai` (endpoint kustom) dan `anthropic` di menu AI. Kunci disimpan terenkripsi di vault PostgreSQL |

Jumlah ini menunjukkan bahwa Indodax saat ini adalah modul kecil di dalam sistem besar untuk venue lain. Perombakan membalik urutannya: Indodax menjadi inti, dan sisanya dibuang.

## 3. Prinsip

1. Satu venue. Tipe `VenueId` menyempit menjadi `'indodax'`. Tidak ada variabel `EXCHANGE`, `MARKET_SOURCE`, atau pemilih venue di Setup.
2. Spot, long-only, tanpa leverage. Kata short, perp, funding, open interest, dan liquidation hilang dari prompt, skema verdict, dan UI.
3. Dua mata uang quote, IDR dan USDT, tetap terpisah. Tidak ada konversi diam-diam, seperti aturan yang sudah ada di [indodax.md](../../indodax.md).
4. Hapus, jangan sembunyikan. Kode yang tidak dipakai Indodax dihapus bersama tesnya. Flag fitur yang dimatikan hanya menambah beban baca.
5. Pengaman tidak turun. Lihat bagian 7.
6. Perubahan bertahap, dengan build dan tes hijau di akhir setiap fase, supaya satu fase yang gagal bisa dibatalkan tanpa merusak yang lain.

## 4. Cakupan

### 4.1 Dipertahankan

| Area | Isi | Catatan |
| --- | --- | --- |
| Data pasar Indodax | `server/market/indodax.ts`, `indodax-params.ts`, `shared/indodax.ts`, `server/v2/api/indodax.ts` | Inti baru |
| Agen dan debat | `server/v2/agents/*`, `server/v2/decision/cycle.ts`, `exits.ts`, `revalidate.ts` | Prompt dan skema ditulis ulang untuk spot, lihat bagian 5 |
| Penyedia model | `server/v2/settings/*`, `server/v2/api/provider-profiles.ts`, `web/src/integrations/ProviderProfiles.tsx` | Vault dan profil tidak berubah |
| Eksekusi Indodax | `server/v2/execution/indodax-client.ts`, `indodax-stops.ts`, `gateway.ts`, `protection.ts`, `reconcile.ts`, `decimal.ts` | Hanya jalur yang dipakai pemantau SL |
| Penyimpanan | `server/v2/store/*` pada PostgreSQL, skema `indodax_stops` | Impor SQLite dan store uji SQLite dikaji di tugas 3.4 |
| Kill switch | `server/killswitch.ts`, `server/v2/kill-file.ts` | Tetap |
| Office | Adegan kantor, enam agen, chat, panel Indodax, AI, Ops, Log, History, Lessons | Panel disederhanakan, lihat bagian 6 |
| CLI | `indodax`, `indodax-stops`, `migrate-postgres`, `doctor`, `kill`, `unkill`, `setup` | `doctor` dan `setup` ditulis ulang untuk Indodax saja |
| Docker | `database`, `app`, `gateway`, `migrate`, `test` | Tetap |
| Lisensi | `LICENSE` (MIT) dan nama penulis asli | Wajib tetap ada, lihat bagian 9 |

### 4.2 Dihapus

| Kelompok | Lokasi | Alasan |
| --- | --- | --- |
| Adaptor venue lain | `server/exchange/*` (kecuali yang dibuktikan dipakai Indodax), `server/v2/execution/adapters/*`, `server/v2/accounts/*` bila hanya melayani multi-venue | Indodax tidak memakainya |
| Wallet dan DEX | `server/wallet.ts`, `server/v2/wallet.ts`, `server/v2/wallet/*`, `contracts/`, `web/src/components/Wallet.tsx`, `WalletMenu.tsx`, `web/src/walletSession.ts`, dependensi `viem`, `starknet`, `@noble/curves`, `@scure/base`, `@msgpack/msgpack` | Indodax memakai kunci API, bukan wallet |
| Data pasar perpetual | `server/v2/market/bybit.ts`, `whale.ts`, `ccxt.ts`, `intelligence.ts`, `opportunity.ts`, `server/market/coinmarketcap.ts`, `positioning.ts`, `whale.ts`, `sui.ts`, `microstructure.ts`, `kronos-client.ts`, `workers/kronos` | Data futures, atau data lintas pasar yang bukan Indodax |
| Sistem desk lama | `server/desk.ts`, `app.ts`, `runtime.ts`, `auto.ts`, `money.ts`, `sizing.ts`, `strategy.ts`, `scan.ts`, `paper.ts`, `trading-settings.ts` | Pembagian modal USDT per slot N dan manajemen posisi perpetual |
| Kanal chat selain Telegram dan jembatan agen luar | Bagian Discord, Slack, WhatsApp di `server/channels/*` dan `server/v2/channels.ts`, `server/v2/connectors/grok/*`, `server/v2/api/grok.ts`, `server/bridge.ts`, `grokbot/`, `muse/`, `MUSE.md`, `GROKBOT_HOST_READONLY_CHECKLIST.md` | Hanya Telegram yang dipertahankan (keputusan 4.3). Grok Bot dan Muse tidak terkait Indodax |
| Backtest perpetual | `server/v2/sandbox/backtest.ts`, `cli/backtest.ts` | Simulator perpetual |
| Riset peramban | `server/v2/research/browser-worker.ts` dan `playwright-core` | Dikaji di tugas 3.5, dihapus jika tidak ada tugas Indodax yang memakainya |
| Tampilan khusus perpetual | Panel posisi leverage, slot N, money split, pemilih venue dan mode TESTNET di `Panels.tsx`, `DeskOps.tsx`, `TradingSetup.tsx`, `Setup.tsx`, `PriceChart.tsx` | Diganti tampilan spot Indodax |
| Dokumen venue lain | `docs/venues.md`, `docs/setup/*`, `docs/live-trading.md`, `docs/grokbot-*.md`, `docs/muse-code.md`, `docs/channels.md`, `docs/external-agent-operations.md`, `docs/financial-history-capabilities.md`, `docs/local-mode.md` bagian venue | Diganti dokumen Indodax |
| Dokumen riwayat | `AUDIT_FINDINGS.md`, `CODE_CHANGES.md`, `TEST_RESULTS.md`, `OPERATIONAL_COMPATIBILITY.md`, `docs/targeted-remediation-*.md`, `docs/rebirth/*`, `docs/qa/*`, `docs/evidence/*` | Dipindah ke tag git `pre-indodax-only` lalu dihapus dari cabang kerja. `CHANGELOG.md` dipertahankan sebagai sejarah |

Daftar ini adalah hipotesis awal dari nama file dan impor. Tugas 0.2 sudah dijalankan dan hasilnya ada di [inventaris](../plans/2026-11-24-indodax-only-inventory.md). Tujuh koreksi dicatat di bagian 3 inventaris dan dipakai di rencana tugas. Yang paling berpengaruh: sistem desk lama tidak terhubung ke jalur hidup sehingga aman dihapus lebih awal, tetapi `money.ts`, `strategy.ts`, `trading-settings.ts`, delapan adaptor venue, dan data pasar perpetual masih terhubung lewat `server/v2/runtime.ts` sehingga harus diputus dulu sebelum dihapus. Modul yang ternyata dipakai jalur Indodax pindah ke kolom Dipertahankan, bukan dipaksa hapus.

### 4.3 Keputusan Owner

Dijawab Owner pada 2026-11-24.

| Hal | Keputusan | Konsekuensi |
| --- | --- | --- |
| Modul analisis candle murni (`indicators.ts`, `smc.ts`, `harmonics.ts`, `alpha-factors.ts`, `monte-carlo.ts`) | Pertahankan `indicators.ts`. `smc`, `harmonics`, `alpha-factors` hanya jika ikut masuk ke `marketSummary` Indodax pada fase 2. `monte-carlo` dihapus | Tugas 2.5 memutuskan per modul dengan bukti hasilnya muncul di konteks |
| Notifikasi chat | Pertahankan satu kanal: Telegram. Discord, Slack, dan WhatsApp dihapus | Telegram tersebar di `server/v2/channels.ts` (58 kemunculan), `server/channels/*`, `server/v2/runtime.ts`, `server/v2/api/setup.ts`, dan `server/reports.ts`. Tugas 3.3 memangkas modul kanal menjadi Telegram saja, bukan menghapusnya. Perintah chat Telegram dibatasi ke perintah Indodax (status, analisis pasangan, kill) |
| Hasil debat di luar sesi PAPER | Verdict disimpan sebagai saran di panel Verdicts. Tidak ada posisi simulasi sampai sesi PAPER dijalankan | Dipakai di tugas 2.4 |
| Entry LIVE dari agen | Di luar cakupan. Hanya pemantau SL yang menjual aset yang sudah Owner miliki | Bagian 11 tidak berubah |
| Cabang git | Tag `pre-indodax-only` pada `main` sekarang, kerja di cabang `indodax-only`, gabung setelah semua gerbang lulus | Dipakai di tugas 0.1 dan 6.4 |

## 5. Memastikan konteks debat selalu Indodax

Ini syarat utama dari Owner, jadi dijaga di empat lapis. Satu lapis yang bocor tidak boleh cukup untuk membawa konteks ke venue lain.

1. Konfigurasi. `VenueId` hanya `'indodax'`. Variabel lingkungan dan setelan yang memilih venue dihapus dari `server/config.ts`, skema setelan, dan Setup. Tidak ada kode yang bisa menyebut venue lain karena tipenya tidak ada.
2. Pembangun konteks. Satu fungsi, `buildIndodaxContext(symbol, timeframe)`, adalah satu-satunya jalan membuat `marketSummary` untuk siklus mana pun, termasuk debat dari Office, perintah `analyze`, dan sesi PAPER. Isinya: pasangan Indodax yang sudah divalidasi, mata uang quote, bid dan ask, fee taker dari `/api/pairs`, minimum order, candle 4 jam atau 1 hari yang sudah tertutup, hasil `indodax-params`, dan blok kendala tetap (spot, long-only, tanpa leverage, tanpa limit GTC, quote IDR dan USDT tidak dicampur). Waktu observasi disertakan supaya data basi ditolak.
3. Prompt dan skema. Prompt enam peran ditulis ulang untuk spot Indodax. Skema verdict hanya menerima `OPEN_LONG`, `HOLD`, dan `CLOSE`. Field leverage, sisi short, dan `LIMIT_GTC` dihapus dari skema, bukan ditolak sesudah diterima seperti sekarang.
4. Validasi simbol. Simbol dari Office, CLI, atau chat dicocokkan ke daftar `/api/pairs` Indodax sebelum siklus berjalan. Perhatikan bahwa `BTCUSDT` adalah pasangan sah di Indodax dan juga nama simbol Bybit, jadi satu-satunya penentu adalah daftar Indodax, bukan bentuk namanya. Pasangan yang tidak ditemukan, maintenance, atau suspended ditolak dengan pesan yang jelas, tanpa jatuh ke data lain.

Tes yang mengunci perilaku ini ada di fase 5: uji snapshot prompt yang gagal bila memuat kata `Bybit`, `perp`, `funding`, `leverage`, `short`, atau `TESTNET`, uji bahwa simbol tidak dikenal ditolak, dan uji graf impor bahwa tidak ada modul sisa venue lain di paket build.

## 6. Perubahan di Office

| Elemen | Sekarang | Sesudah |
| --- | --- | --- |
| Menu alat | AI, Indodax, Ops, Portfolio, Lessons, Log, History | AI, Indodax, Lessons, Log, History. Portfolio dan Ops dirancang ulang menjadi tampilan spot Indodax: kas simulasi, posisi simulasi, SL yang dipantau, batas rugi harian |
| Mulai debat | Memilih simbol dari watchlist perpetual | Memilih pasangan Indodax dan timeframe 4h atau 1d. Mengisi konteks lewat `buildIndodaxContext` |
| Grafik | TradingView dan grafik harga untuk simbol futures | Grafik candle Indodax yang sudah ada di panel Indodax, dipakai juga di layar utama |
| Setup | Wizard venue, jaringan, mode, wallet, kanal | Satu layar: kunci Indodax (opsional untuk PAPER), profil AI, cek izin kunci. Tanpa pemilih venue |
| Mode | PAPER, TESTNET, LIVE | PAPER dan LIVE. Indodax tidak punya testnet yang dipakai proyek ini, dan LIVE hanya menyentuh pemantau SL |
| Bahasa | Indonesia dan Inggris | Tetap |

Kata-kata di UI mengikuti aturan antislop untuk teks: nama aksi yang spesifik, tanpa istilah pemasaran, tanpa angka tanpa sumber.

## 7. Pengaman yang tidak boleh turun

Daftar ini diambil dari `AGENTS.md`, `docs/indodax-bot-stops.md`, dan perilaku kode saat ini. Setiap butir punya tes di fase 5.

1. Kill switch menghentikan siklus agen dan pemantau, dan diperiksa lagi sebelum setiap penulisan.
2. Batas rugi harian dari setelan Desk menghentikan siklus entry berikutnya.
3. Kunci Indodax hanya boleh punya izin trading. Kunci dengan izin penarikan, atau izin yang tidak diketahui, ditolak. Tidak ada kode penarikan atau transfer.
4. LIVE membutuhkan kalimat konfirmasi yang diketik Owner. Agen pengembang tidak mengaktifkan LIVE.
5. Kunci hanya disimpan terenkripsi di vault (AES-256-GCM, master key sebagai Docker secret). Kunci tidak muncul di log, laporan, chat, atau argumen CLI.
6. Endpoint Office hanya menerima klien loopback dengan origin lokal.
7. Teks pasar, berita, dan balasan penyedia diperlakukan sebagai data tidak tepercaya. Pesan error penyedia boleh tampil di diagnostik PAPER (sudah dilakukan di commit `3904fed`), tetapi tidak masuk ke balasan chat.
8. SL Indodax tetap ditandai `BOT_MANAGED`, bukan terverifikasi exchange. Pengecualian Owner di `AGENTS.md` tetap berlaku apa adanya.
9. Pemantau SL memakai jalur `ExecutionGateway.close`, intent tahan banting, dan isolasi akun yang sudah ada. Fase penghapusan tidak boleh mengubah perilakunya.

Menyempitkan cakupan bukan melonggarkan pengaman. Namun `AGENTS.md` melarang pelonggaran dan berisi banyak aturan khusus venue lain. Penulisan ulang `AGENTS.md` (tugas 6.1) membutuhkan persetujuan Owner secara eksplisit sebelum dikerjakan, dan hanya boleh menghapus butir yang objeknya sudah tidak ada.

## 8. Risiko

| Risiko | Dampak | Penanganan |
| --- | --- | --- |
| Modul yang tampak mati ternyata dipakai jalur Indodax lewat impor tidak langsung (`types.ts` diimpor 56 file, `config.ts` 27 file) | Build rusak di tengah penghapusan | Graf impor di tugas 0.2, penghapusan per kelompok dengan `typecheck` dan build di tiap langkah, `types.ts` dan `config.ts` dipangkas terakhir |
| `server/v2/runtime.ts` (222 KB) memuat logika debat, eksekusi, kanal, dan wallet dalam satu file | Sulit dipotong dengan aman | Pecah dulu menjadi modul kecil per tanggung jawab (tugas 3.1), baru hapus |
| Tes yang ada (153 entri) sebagian besar menguji venue lain | Kehilangan jaring pengaman tanpa disadari | Klasifikasikan tiap tes (pertahankan, tulis ulang, hapus) di tugas 0.3 sebelum menghapus kodenya. Tes pengaman bagian 7 tidak boleh ikut terhapus |
| Kapasitas penyedia model: satu siklus memanggil sekitar 9 role berurutan, dan sesi tadi gagal dengan HTTP 429 dari `openrouter/free` lalu HTTP 503 `All providers busy` dari jerouter | Debat tidak selesai walau kodenya benar | Catat jumlah panggilan per siklus, tambah jeda dan batas coba ulang yang terukur (tugas 4.5). Ini bukan bagian penghapusan, tetapi menentukan apakah hasil perombakan bisa dicoba |
| Riwayat git terpisah dari upstream | Pembaruan upstream tidak bisa lagi diambil lewat cherry-pick | Terima sebagai konsekuensi. Remote `upstream` tetap boleh dipertahankan untuk referensi baca |
| Penghapusan mengubah `package.json`, `package-lock.json`, dan build Docker | Image Docker gagal dibangun | Bangun image dan jalankan satu sesi PAPER di akhir setiap fase |
| Vitest memakai pool `forks` yang rusak di Node 26 pada mesin Owner, dan beberapa tes gagal di pool `vmThreads` karena `dotenv` | Gerbang tes tidak bisa dijalankan lokal | Jalankan gerbang tes lewat layanan `test` di Docker (tugas 0.4) |

## 9. Lisensi dan atribusi

Proyek asli berlisensi MIT, penulis Abrur Alaina. Lisensi MIT mewajibkan pemberitahuan hak cipta dan teks lisensi tetap ada dalam salinan yang substansial. `LICENSE` tidak dihapus dan nama penulis di `package.json` tetap. Perubahan Owner ditambahkan di `CHANGELOG.md` sebagai entri baru, bukan menggantikan riwayat.

## 10. Kriteria selesai

1. `npm run typecheck`, `npm run build`, dan seluruh tes yang tersisa lulus di layanan `test` Docker.
2. Pencarian teks pada `server`, `web/src`, `cli`, `shared`, dan `docs` tidak menemukan `bybit`, `hyperliquid`, `aster`, `okx`, `dydx`, `paradex`, `orderly`, `binance`, `perp`, `funding`, `leverage`, `testnet`, `discord`, `slack`, `whatsapp`, `grok`, `muse`, kecuali di `CHANGELOG.md`, `LICENSE`, dan dokumen sejarah yang diberi tanda.
3. Image Docker terbangun. `database`, `app`, `gateway` sehat.
4. Satu sesi PAPER dijalankan dari Office pada pasangan Indodax nyata. Prompt yang dikirim ke penyedia (diambil dari log diagnostik) hanya menyebut Indodax, spot, dan pasangan terpilih.
5. Permintaan debat dengan simbol yang bukan pasangan Indodax ditolak dengan pesan yang jelas.
6. Panel Indodax, AI, Log, History, dan Lessons berfungsi di Office pada layar desktop dan ponsel, termasuk tampilan kosong, memuat, dan galat.
7. Semua butir bagian 7 punya tes yang lulus.
8. `README.md`, `AGENTS.md` (setelah persetujuan Owner), dan `docs/` hanya membahas Indodax.

## 11. Di luar cakupan

Entry LIVE oleh agen, penambahan venue lain, backtest spot Indodax, kanal chat selain Telegram, penjadwalan lintas pasangan, dan optimasi strategi. Semuanya bisa menjadi rancangan terpisah setelah kriteria selesai terpenuhi.
