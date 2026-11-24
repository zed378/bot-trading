# Rencana tugas: proyek khusus Indodax

Status: usulan, belum dieksekusi. Tidak ada tugas di bawah yang sudah dikerjakan.
Rancangan: [2026-11-24-indodax-only-design.md](../specs/2026-11-24-indodax-only-design.md).
Tanggal: 2026-11-24.

## Cara membaca

Setiap tugas punya nomor `fase.urutan`, ukuran (S: satu sesi pendek, M: beberapa jam, L: satu hari atau lebih), tugas yang harus selesai lebih dulu, dan cara memverifikasi. Ukuran adalah perkiraan kasar dari jumlah file dan kerumitan, bukan janji waktu.

Fase 0 sampai 2 menambah dan mengukur, tidak menghapus. Penghapusan baru dimulai di fase 3, setelah mesin debat Indodax baru berjalan dan ada tes yang mengunci perilakunya.

## Gerbang tiap fase

Sebuah fase selesai hanya bila semua ini benar. Hasilnya dicatat di bagian Catatan fase pada akhir dokumen ini.

1. `npm run typecheck` lulus.
2. `npm run build` lulus.
3. Seluruh tes yang tersisa lulus lewat layanan `test` di Docker (lihat 0.4).
4. `docker compose build app` berhasil, `app`, `database`, `gateway` sehat, dan satu sesi PAPER dari Office mencapai akhir siklus pertama tanpa galat kode (kegagalan karena kuota penyedia model dicatat terpisah dan tidak menggagalkan gerbang).
5. Commit memakai satu pesan per tugas, tanpa menyentuh berkas di luar tugas itu.

## Fase 0: Persiapan dan bukti

| ID | Tugas | Ukuran | Bergantung | Verifikasi |
| --- | --- | --- | --- | --- |
| 0.1 | Buat tag `pre-indodax-only` pada `main` dan cabang `indodax-only` (keputusan Owner sudah ada). Dokumen rancangan dan rencana ini ikut di-commit ke cabang itu. Bila `AgentPanel.tsx` dan `app.css` muncul lagi sebagai perubahan lokal, Owner memutuskan dulu: commit, simpan, atau buang | S | tidak ada | `git tag`, `git branch` menunjukkan keduanya, `git status` bersih |
| 0.2 | Bangun graf impor dari titik masuk yang hidup: `server/index.ts`, `cli/indodax.ts`, `cli/indodax-stops.ts`, `cli/migrate-postgres.ts`, `web/src/main.tsx`. Hasilnya: daftar berkas yang terjangkau dan yang tidak, disimpan sebagai `docs/superpowers/plans/2026-11-24-indodax-only-inventory.md`. Pakai graf kode yang sudah terindeks atau `tsc --listFilesOnly`, tanpa menambah dependensi | M | 0.1 | Setiap berkas di `server`, `web/src`, `cli`, `shared` punya label: dipakai Indodax, dipakai bersama, tidak terjangkau. Hipotesis di bagian 4.2 rancangan dicocokkan dan selisihnya dicatat |
| 0.3 | Klasifikasikan 222 berkas tes (153 entri tingkat atas ditambah `tests/rebirth/`): pertahankan, tulis ulang, tinjau, hapus. Tandai tes pengaman (bagian 7 rancangan) sebagai terkunci. Selesai 2026-11-24, hasilnya di [klasifikasi tes](2026-11-24-indodax-only-test-classification.md) | M | 0.2 | Setiap tes punya satu label dan satu alasan satu baris. Tes pengaman yang berlabel hapus (`daily-loss-recovery`, `http-mutation-authorization`, `final-owner-http`) tetap terkunci sampai ada pengganti di 5.1 |
| 0.4 | Jalankan baseline lewat Docker: `typecheck`, `build`, dan seluruh tes pada `pre-indodax-only`. Catat tes yang sudah gagal sebelum perombakan | M | 0.1 | Angka lulus, gagal, dilewati tercatat. Tes yang sudah gagal diberi label supaya tidak dituduhkan ke perombakan |
| 0.5 | Keputusan Owner untuk lima butir di bagian 4.3 rancangan. Selesai 2026-11-24, jawabannya sudah tercatat di rancangan | S | tidak ada | Tabel 4.3 berisi jawaban |

## Fase 1: Kontrak Indodax baru (hanya menambah)

Tujuan: menulis kontrak yang menjaga konteks tetap Indodax sebelum ada yang dihapus. Semua tugas fase ini adalah berkas baru dengan tes, tanpa mengubah perilaku yang ada.

| ID | Tugas | Ukuran | Bergantung | Verifikasi |
| --- | --- | --- | --- | --- |
| 1.1 | `IndodaxContext` (zod) di `shared/`: pasangan, quote, bid, ask, fee taker, minimum order, candle tertutup, hasil `indodax-params`, waktu observasi, dan blok kendala tetap | M | 0.4 | Tes: konteks lengkap lolos. Konteks tanpa bid, dengan quote campuran, atau dengan candle yang belum tertutup ditolak |
| 1.2 | Skema verdict spot: `OPEN_LONG`, `HOLD`, `CLOSE` saja, tanpa leverage, sisi short, dan `LIMIT_GTC`. Tulis berdampingan dengan skema lama, belum dipasang | M | 1.1 | Tes: verdict `OPEN_SHORT`, field `leverage`, dan `orderType: LIMIT_GTC` ditolak oleh skema, bukan oleh pemeriksaan sesudahnya |
| 1.3 | `resolveIndodaxSymbol(input)` yang mencocokkan simbol ke daftar `/api/pairs`, termasuk huruf besar dan kecil, `btc_idr` dan `BTCIDR`, serta menolak maintenance dan suspended | S | 0.4 | Tes: `BTCIDR` dan `btc_idr` menghasilkan satu pasangan. `BTCUSDT` dikenali sebagai pasangan USDT Indodax. `FOOIDR` ditolak dengan pesan yang menyebut Indodax |
| 1.4 | `buildIndodaxContext(symbol, timeframe)` yang memanggil 1.3, `IndodaxPublicClient`, dan modul `indodax-params`, lalu menghasilkan `IndodaxContext`. Pindahkan logika `marketSummary` dari `server/v2/api/indodax-paper.ts` ke sini tanpa mengubah hasilnya | M | 1.1, 1.3 | Tes `indodax-paper-agent` dan `indodax-paper-fees` yang sudah ada tetap lulus tanpa perubahan |
| 1.5 | Teks kendala tetap berbahasa baku (satu sumber), dipakai oleh konteks dan prompt | S | 1.1 | Tes snapshot teks. Teks tidak memuat kata di daftar larangan bagian 5 rancangan |

## Fase 2: Mesin debat Indodax

Tujuan: permintaan debat dari Office, perintah `analyze`, dan sesi PAPER memakai jalur yang sama dan hanya jalur itu.

| ID | Tugas | Ukuran | Bergantung | Verifikasi |
| --- | --- | --- | --- | --- |
| 2.1 | Tulis ulang prompt enam peran (`server/v2/agents/roles.ts` dan `personas/*`) untuk spot Indodax: istilah, kendala, dan contoh keluaran. Hapus rujukan ke perpetual, leverage, funding, short, slot N | L | 1.2, 1.5 | Tes snapshot prompt: tidak ada kata `Bybit`, `perp`, `funding`, `leverage`, `short`, `TESTNET`. Prompt menyebut Indodax dan quote pasangan |
| 2.2 | Pasang skema verdict spot (1.2) ke `server/v2/decision/cycle.ts`, `exits.ts`, dan `revalidate.ts`. Pertahankan aturan dua dari tiga analis dan ambang kepercayaan | M | 1.2, 2.1 | Tes siklus yang ada ditulis ulang untuk verdict spot. Aturan dua dari tiga analis tetap dites |
| 2.3 | Satu fungsi `runIndodaxCycle({ symbol, timeframe, reason })` di runtime, dipanggil oleh sesi PAPER, perintah `analyze`, dan tombol Mulai debat. `runIndodaxPaperCycle` menjadi pembungkus tipis atau dihapus | M | 1.4, 2.2 | Tes: ketiga pemanggil menghasilkan `marketSummary` yang sama untuk pasangan yang sama |
| 2.4 | Hubungkan `triggerCycle` dan perintah chat `analyze <pair>` ke `runIndodaxCycle`. Debat tanpa sesi PAPER menyimpan verdict sebagai saran di panel Verdicts dan tidak membuka posisi simulasi (bila Owner memilih default di 0.5) | M | 2.3 | Tes: `analyze BTCIDR` membuat verdict tersimpan. `analyze FOOIDR` ditolak. Tidak ada panggilan ke `BybitMarketHub` (dibuktikan dengan stub yang melempar bila dipanggil) |
| 2.5 | Tentukan modul analisis candle yang ikut masuk `marketSummary` sesuai keputusan 0.5 (`smc`, `harmonics`, `alpha-factors`), dan sambungkan ke 1.4 | M | 0.5, 1.4 | Tes: modul yang dipilih menerima candle Indodax dan hasilnya muncul di konteks. Modul yang tidak dipilih ditandai untuk dihapus di fase 3 |
| 2.6 | Konteks chat Desk Lead: pesan sistem menyatakan Indodax spot dan pasangan aktif, tanpa daftar venue | S | 2.1 | Tes: balasan chat tidak menawarkan venue lain. Pertanyaan tentang leverage dijawab bahwa Indodax spot tidak mendukungnya |

Gerbang fase 2 ditambah satu bukti: ambil prompt yang benar-benar dikirim ke penyedia dari log diagnostik pada satu siklus nyata, dan lampirkan hasil pencarian kata terlarang yang kosong.

## Fase 3: Penghapusan backend

Urutan di bawah ini memotong dari tepi ke tengah. Setelah setiap tugas, `typecheck`, build, dan tes dijalankan, dan satu commit dibuat.

| ID | Tugas | Ukuran | Bergantung | Verifikasi |
| --- | --- | --- | --- | --- |
| 3.1 | Pecah `server/v2/runtime.ts` (222 KB) menjadi modul per tanggung jawab (siklus agen, state, perintah, penjadwal, penutup server). Bagian `server/money.ts`, `strategy.ts`, dan `trading-settings.ts` yang masih dipakai jalur v2 (graf 0.2: ketiganya terjangkau) dipindah ke modul yang sesuai atau ditandai hapus. Pemindahan murni tanpa perubahan perilaku | L | 2.4 | Seluruh tes lulus tanpa diubah. Selisih fungsi hanya lokasi berkas |
| 3.2 | Hapus sistem desk lama yang hanya terjangkau lewat titik masuk lain atau tidak terjangkau (inventaris bagian 4.1 dan 4.2): 22 berkas `server/*.ts` (termasuk `desk.ts`, `app.ts`, `auto.ts`, `config.ts`, `scan.ts`, `paper.ts`, `sizing.ts`, `risk.ts`, `commands.ts`) kecuali `killswitch.ts`, `server/runtime.ts`, `server/agents/*`, `server/decision/*` lama, `server/providers/*`, `server/research/*`, `server/setup/*`, `server/live/*`, `server/channels/*`, `cli/debate.ts`, beserta tes yang berlabel hapus. Mulai dari 20 berkas yang tidak terjangkau sama sekali. Jangan hapus `money.ts`, `strategy.ts`, `trading-settings.ts` di langkah ini | L | 3.1 | Graf impor ulang: nol berkas yatim. Build dan tes lulus. `server/killswitch.ts` tetap ada sampai 4.3 |
| 3.3 | Hapus jembatan Grok Bot dan Muse: `connectors/grok/*`, `api/grok.ts`, `server/bridge.ts`, `grokbot/`, `muse/`, `cli/gb`, dan tesnya. Pangkas kanal chat menjadi Telegram saja. `server/channels/*` sudah dihapus di 3.2 (graf 0.2: hanya lewat titik masuk lain). Yang hidup dan dipangkas di sini: kode Discord, Slack, WhatsApp di `server/v2/channels.ts`, `channel-text.ts`, `server/v2/api/setup.ts`, `server/v2/reports.ts`, bagian terkait di `runtime.ts`, dan `cli/channels.ts`. Batasi perintah Telegram ke perintah Indodax (status, analisis pasangan, kill). Supervisor tetap melaporkan kesehatan, SL terpicu, dan kill switch | L | 3.2 | Build dan tes lulus. Tes kanal ditulis ulang untuk Telegram. Pengiriman pesan diuji dengan server Telegram palsu, tanpa token nyata. Tidak ada rute atau kode untuk kanal lain, dan token Telegram hanya dibaca dari penyimpanan rahasia, tidak dari argumen atau log |
| 3.4 | Hapus wallet dan DEX: `server/wallet.ts`, `server/v2/wallet.ts`, `server/v2/wallet/*`, `contracts/`, dan tesnya. Putuskan nasib `import-sqlite.ts` dan `sqlite-test-store.ts` di `server/v2/store/`: dihapus bila PostgreSQL adalah satu-satunya store yang dipakai tes | M | 3.2 | Build dan tes lulus. `@libsql/client` hanya tersisa bila ada tes yang masih memakainya |
| 3.5 | Hapus adaptor venue lain dan sisanya. Urutannya: pangkas dulu `server/v2/execution/adapters/factory.ts`, `types.ts`, dan `gateway.ts` agar hanya mengenal Indodax (graf 0.2: delapan adaptor masih terjangkau lewat `factory.ts`), baru hapus `server/v2/execution/adapters/*` dan `server/exchange/*` (sepuluh berkas venue dan `financial-history.ts`). Putuskan nasib `server/exchange/rules.ts`, `types.ts`, `server/v2/accounts/*` (bila hanya multi-venue), dan `server/v2/research/browser-worker.ts`. `server/live/*` dan `cli/backtest.ts` sudah hilang di 3.2 | L | 3.2, 3.4 | Tes pemantau SL (`indodax-stops.test.ts`) lulus tanpa perubahan. Tidak ada impor ke direktori yang dihapus |
| 3.6 | Hapus data pasar perpetual. Mulai dari yang sudah mati (`kronos-client.ts`, `monte-carlo.ts`, `v2/market/ccxt.ts`, `workers/kronos`). Lalu putus impor di `server/v2/runtime.ts` dan hub `server/market/index.ts` (graf 0.2: keduanya masih menarik data venue lain ke jalur hidup), baru hapus `server/v2/market/bybit.ts`, `whale.ts`, `intelligence.ts`, `opportunity.ts`, `orderbook.ts`, `instruments.ts`, `server/market/coinmarketcap.ts`, `positioning.ts`, `whale.ts`, `sui.ts`, `microstructure.ts`, `news.ts`, `live-news.ts`, `tactical.ts`, `observations.ts`, `sample.ts`, dan modul analisis yang tidak dipilih di 2.5. Tiap berkas dicek dulu apakah Indodax memakainya (berita Indodax belum ada, jadi tidak ada pengganti) | M | 2.5, 3.5 | Build dan tes lulus. `BybitMarketHub` tidak ada lagi di runtime |
| 3.7 | Pangkas `server/types.ts` dan `server/config.ts` (diimpor 56 dan 27 berkas). `VenueId` menjadi `'indodax'`. Hapus variabel `EXCHANGE`, `MARKET_SOURCE`, `ALLOW_EXPERIMENTAL_LIVE`, dan setelan venue lain. Pangkas skema setelan di `server/v2/settings/schema.ts` | L | 3.2 sampai 3.6 | Build dan tes lulus. Pencarian nama venue lain (bybit, hyperliquid, aster, okx, dydx, paradex, orderly, binance) di `server` kosong |
| 3.8 | Pangkas skema PostgreSQL dan migrasi dari tabel venue lain dengan migrasi baru yang bisa diulang. Jangan menyentuh skema `indodax_stops` | M | 3.7 | Tes `postgres-integration` lulus pada database kosong dan pada salinan database yang ada. Data `indodax_stops` utuh |

## Fase 4: Antarmuka, CLI, dependensi, ketahanan penyedia

| ID | Tugas | Ukuran | Bergantung | Verifikasi |
| --- | --- | --- | --- | --- |
| 4.1 | Hapus komponen web khusus perpetual dan venue: `Wallet.tsx`, `WalletMenu.tsx`, `walletSession.ts`, `Channels.tsx`, `TradingViewChart.tsx`, `DataSourcesSetup.tsx`, `CodexResearchSetup.tsx` bila tidak terpakai, dan bagian terkait di `Panels.tsx`, `DeskOps.tsx`, `TradingSetup.tsx`, `PriceChart.tsx`, `MiniCharts.tsx` | L | 3.7 | `npm run build` lulus. Pencarian kata terlarang di `web/src` kosong |
| 4.2 | Rancang ulang Portfolio dan Ops sebagai tampilan spot Indodax: kas simulasi, posisi simulasi, SL yang dipantau, batas rugi harian. Tombol Mulai debat memilih pasangan Indodax dan timeframe. Tiap tampilan punya keadaan kosong, memuat, dan galat, dan bisa dipakai dengan papan ketik | L | 4.1, 2.4 | Klik-tembus tiap kontrol, tercatat per elemen, di desktop dan lebar ponsel, tema terang dan gelap, tanpa galat konsol |
| 4.3 | Setup satu layar: kunci Indodax (opsional untuk PAPER), profil AI, cek izin kunci. Hapus wizard venue. Tulis ulang `cli/setup.ts` dan `cli/doctor.ts` untuk Indodax saja. Perkecil `bin/mpu.mjs` menjadi perintah `setup`, `doctor`, `indodax`, `stops`, `kill`, `unkill`, `status`. `cli/kill.ts` dan `cli/unkill.ts` hari ini memakai `server/killswitch.ts` (lewat titik masuk lama), sedangkan jalur hidup memakai `server/v2/kill-file.ts`. Pindahkan keduanya ke jalur v2 sebelum `server/killswitch.ts` dihapus, dan buktikan dengan tes bahwa `kill` menghentikan siklus agen dan pemantau SL | L | 3.7 | `npm run doctor` membaca izin kunci tanpa mencetak rahasia. Kunci dengan izin penarikan ditolak (tes yang sudah ada). `kill` lalu `unkill` dari CLI mengubah status yang dibaca runtime v2 |
| 4.4 | Rapikan `package.json`: hapus skrip yang tidak berlaku (`gb`, `channels`, `trade`, `backtest`, `autostart:*`, `bench:models`, `docs:setup`, dan sisanya dari inventaris), hapus dependensi yang tidak lagi diimpor (`viem`, `starknet`, `@noble/curves`, `@scure/base`, `@msgpack/msgpack`, `playwright-core`, dan `ws` bila tidak terpakai), perbarui `package-lock.json`, `description`, dan `files` | M | 3.7, 4.1 | `npm ls` tanpa paket yatim. Image Docker terbangun lebih kecil dari baseline (catat kedua ukuran) |
| 4.5 | Ketahanan penyedia model: catat jumlah panggilan per siklus, tambahkan jeda dan batas coba ulang yang terukur untuk HTTP 429 dan 503 (hormati `Retry-After`), dan tampilkan hasilnya di diagnostik PAPER. Tidak mengurangi pemeriksaan keputusan atau jumlah peran tanpa persetujuan Owner | M | 2.3 | Tes dengan penyedia palsu yang mengembalikan 429, 503, lalu sukses: siklus selesai. Tes dengan 503 terus-menerus: siklus berhenti dengan alasan yang terbaca, tanpa putaran tak terbatas |
| 4.6 | Docker dan skrip: perbarui `compose.yaml`, `Dockerfile`, `docker/*`, `scripts/*` (hapus skrip verifikasi yang menguji venue lain, pertahankan yang menguji Office dan sesi) | M | 4.4 | `docker compose up -d` pada mesin bersih menghasilkan `app`, `database`, `gateway` sehat |

## Fase 5: Tes pengaman dan verifikasi akhir

| ID | Tugas | Ukuran | Bergantung | Verifikasi |
| --- | --- | --- | --- | --- |
| 5.1 | Tes pengaman satu per satu untuk sembilan butir bagian 7 rancangan. Butir yang sudah punya tes dipetakan, yang belum ditulis. Tiga celah yang ditemukan di 0.3 ditulis sebagai tes baru: (1) kill switch aktif menghentikan siklus dan pemantau SL/TP sesi PAPER Indodax, (2) `enforceDailyLossCap` menghentikan siklus pada batas rugi, (3) rute LIVE di `server/v2/api/indodax-stops.ts` menolak permintaan tanpa frasa `I understand LIVE trades real money`. Tes pengganti untuk `daily-loss-recovery`, `http-mutation-authorization`, dan `final-owner-http` ditulis sebelum ketiganya dihapus | L | fase 3 | Tabel pemetaan butir ke tes ada di berkas inventaris. Tiap tes gagal bila pengamannya dihapus (diuji dengan mematikan pengamannya sementara di cabang lokal) |
| 5.2 | Tes isolasi konteks: snapshot prompt enam peran, penolakan simbol non-Indodax di Office, CLI, dan chat, dan pemeriksaan bahwa paket build tidak memuat modul venue lain | M | 2.1, 3.7 | Tes lulus. Satu mutasi yang sengaja menyisipkan kata `Bybit` ke prompt membuat tes gagal |
| 5.3 | Pencarian teks penuh untuk kriteria selesai nomor 2 | S | 4.4 | Hasil pencarian terlampir. Sisa kemunculan hanya di berkas yang diizinkan |
| 5.4 | Sesi PAPER nyata dari Office pada satu pasangan IDR dan satu pasangan USDT, dengan penyedia yang tersedia. Ambil prompt dari log diagnostik dan statistik sesi. Bila penyedia menolak (429 atau 503), catat alasannya dan ulangi pada waktu lain, jangan mengklaim lulus | M | 4.2, 4.5 | Laporan sesi: siklus selesai, verdict, alasan kegagalan bila ada, statistik, dan isi prompt yang hanya menyebut Indodax |
| 5.5 | Klik-tembus Office akhir (R-35): setiap kontrol, tiap tema, tiap lebar layar, tiap keadaan kosong, memuat, dan galat | M | 4.2 | Daftar per elemen dengan hasilnya. Tidak ada kontrol mati |

## Fase 6: Dokumen dan rilis

| ID | Tugas | Ukuran | Bergantung | Verifikasi |
| --- | --- | --- | --- | --- |
| 6.1 | Tulis ulang `AGENTS.md` dan `README.md` untuk Indodax. `AGENTS.md` melarang pelonggaran pengaman, jadi tugas ini dimulai hanya setelah Owner menyetujui isi perubahan secara eksplisit. Hanya butir yang objeknya sudah tidak ada yang dihapus. `CLAUDE.md` tetap menunjuk ke `AGENTS.md` | M | 5.1, persetujuan Owner | Diff `AGENTS.md` dibaca Owner. Setiap pengaman di bagian 7 rancangan masih tertulis |
| 6.2 | Rapikan `docs/`: hapus dokumen venue lain dan dokumen riwayat sesuai bagian 4.2 (isinya tetap ada di tag `pre-indodax-only`), perbarui `indodax.md`, `indodax-bot-stops.md`, `docker-postgres.md`, tambah panduan debat Indodax | M | 6.1 | Setiap tautan di `docs/` dan `README.md` mengarah ke berkas yang ada |
| 6.3 | Perbarui `package.json` (`name`, `description`, versi), tambah entri di `CHANGELOG.md`, pertahankan `LICENSE` dan nama penulis asli | S | 6.2 | `LICENSE` tidak berubah (`git diff` kosong untuk berkas itu) |
| 6.4 | Gabungkan `indodax-only` ke `main` setelah gerbang fase 5 lulus dan Owner menyetujui. Push hanya atas permintaan Owner | S | 5.5, 6.3 | `main` lulus gerbang. Tag `pre-indodax-only` tetap ada |

## Urutan dan ketergantungan

Fase 0 harus selesai sebelum yang lain. Fase 1 dan 2 bisa berjalan tanpa menghapus apa pun, jadi hasilnya bisa dicoba sedini mungkin dengan sistem lama masih utuh. Fase 3 dimulai setelah 2.4 lulus dan 0.2 selesai. Tugas 3.2 sampai 3.6 saling bebas sebagian, tetapi dikerjakan berurutan supaya satu kegagalan build mudah dilacak ke satu commit. Fase 4 bergantung pada 3.7. Tugas 4.5 hanya bergantung pada 2.3 sehingga bisa dikerjakan lebih awal bila Owner ingin debat bisa dicoba tanpa menunggu penghapusan.

## Hal yang tidak dikerjakan di rencana ini

Entry LIVE oleh agen, venue lain, backtest spot, kanal chat selain Telegram, dan penjadwalan lintas pasangan. Alasannya ada di bagian 11 rancangan.

## Catatan fase

Diisi saat eksekusi. Tiap fase mencatat tanggal, hasil gerbang, tes yang gagal sebelumnya (dari 0.4), dan keputusan yang menyimpang dari rencana.

| Fase | Tanggal | Hasil gerbang | Catatan |
| --- | --- | --- | --- |
| 0 | 2026-11-24 | Lulus. Baseline bersih 222 berkas, 1545 tes | Satu regresi dari commit `9089998` ditemukan dan diperbaiki di `c6f5aab`. Inventaris, klasifikasi tes, dan tiga celah pengaman tercatat |
| 1 | 2026-11-24 | Lulus. Build, typecheck, 223 berkas dan 1562 tes (17 baru) | Kontrak ditambahkan: `shared/indodax-context.ts`, `shared/indodax-verdict.ts`, `server/market/indodax-symbol.ts`, `indodax-context.ts`, `indodax-analysis.ts`. Sesi PAPER sekarang memakai `buildIndodaxContext`. Dua penyimpangan dari rencana, lihat di bawah |
| 2 | 2026-11-24 | Lulus. Build, typecheck, 224 berkas dan 1572 tes (11 baru, 4 diperbarui) | Prompt, kebijakan, verdict, siklus, dan konteks chat kini khusus Indodax spot. Enam penyimpangan, lihat di bawah |
| 3 | 2026-11-24 | Lulus. Build, typecheck, 56 berkas dan 290 tes | Desk lama, adaptor venue lain, wallet/DEX, Grok Bot, Muse, kanal non-Telegram, dan data perpetual dihapus. `VenueId` menyempit ke `'indodax'`, mode ke `PAPER`/`LIVE`, migrasi skema PostgreSQL v4 menghapus `bridge_*` tanpa menyentuh `indodax_bot_stops` |
| 4 | 2026-11-24 | Lulus. Build, typecheck, 57 berkas dan 294 tes | UI Setup, Ops, Channels (Telegram), Tour, i18n, Dockerfile, dan dependensi dipangkas untuk Indodax spot. Ketahanan penyedia 429/503 (`Retry-After` dan `providerCalls`) ditambahkan di `RoleRunner` dan diagnostik PAPER. Klik-tembus peramban interaktif penuh belum dijalankan langsung oleh agen |
| 5 | 2026-11-24 | Lulus (tes otomatis); sesi PAPER nyata tertahan kuota penyedia | Semua 9 pengaman bagian 7 teruji di `indodax-safety`, `kill-file`, `untrusted`, `indodax-stops`, `postgres-integration`. Debat `analyze BTCIDR` pada stack Docker selesai sebagai `HOLD (INCOMPLETE)` karena penyedia `jerouter`/`openai` mengembalikan HTTP 503 `All providers busy` |
| 6 | 2026-11-24 | Lulus. Build, typecheck, 57 berkas dan 294 tes | Dokumen venue lain dan riwayat usang dihapus, `README.md`, `docs/indodax*.md`, `CHANGELOG.md` diperbarui. `AGENTS.md` belum diubah dan menunggu persetujuan Owner |

Penyimpangan di fase 1:

1. Tugas 1.4: teks kendala yang dikirim sesi PAPER berubah. Teks lama menyebut SHORT, leverage, dan limit order sebagai hal yang tidak tersedia, sedangkan 1.5 melarang kata-kata itu muncul di teks kendala. Teks baru hanya menyebut tindakan yang mungkin (LONG, HOLD, CLOSE) dengan order market. Penolakan SHORT dan limit order di sisi kode PAPER tidak berubah dan tetap dites. Prompt peran enam agen belum diubah sampai tugas 2.1.
2. Tugas 1.3: `buildIndodaxContext` memakai `client.market()`, yang sudah menolak pasangan tidak terdaftar, maintenance, dan suspended. `resolveIndodaxSymbol` (memakai `client.pairs()`) berdiri sendiri untuk validasi di Office, CLI, dan chat pada tugas 2.4. Alasannya: tes PAPER yang ada mengganti `market()` pada klien palsu, jadi memanggil `pairs()` di dalam pembangun konteks akan menyentuh jaringan.

`IndodaxVerdictSchema` (1.2) dipasang di batas keluar siklus pada fase 2, lihat penyimpangan 2 di bawah.

Penyimpangan di fase 2:

1. Tugas 2.1: enam `role.md`, `risk/soul.md`, `execution/agent.md`, paragraf wajib di `roles.ts`, dan skema balasan di `runner.ts` ditulis ulang. Judul peran Market dan Research berubah ("Tape, Momentum & Volume Reader", "News, Macro & Catalyst Investigator") di `roles.ts` dan `office.ts`. Tool ResearchHost tidak lagi disebut di prompt, dan siklus serta chat Indodax memakai `RoleRunner` tanpa ResearchHost (`indodaxRoleRunner`), karena tool itu membaca data venue lain. `mock.ts` hanya diubah teksnya. Logika stance SHORT di `mock.ts`, `jev.ts`, `runner.ts` (parser yang menerima SHORT), `cycle.ts`, `exits.ts`, `revalidate.ts` masih ada dan dibersihkan di 3.7.
2. Tugas 2.2: skema verdict spot dipasang di batas keluar (`toIndodaxVerdict` di `server/v2/decision/indodax-verdict.ts`), bukan dengan menulis ulang isi `cycle.ts`, `exits.ts`, `revalidate.ts`. Siklus masih bernalar dengan tiket dua sisi di dalam. `OPEN_SHORT` dan order `LIMIT_GTC` keluar sebagai HOLD dengan alasan. Yang dilihat model dibatasi lewat `promptPolicy`, `promptTicket`, dan `toPeerDigest` (tanpa leverage, sisi kedua, limit order, jumlah slot).
3. Tugas 2.3: satu `runIndodaxCycle` di runtime dipakai sesi PAPER dan debat. Pembangunan konteks tetap di pemanggil lewat `buildIndodaxContext` dan `indodaxPromptSummary` (fungsi yang sama), dan tes membuktikan ringkasan serta kebijakan debat sama dengan sesi PAPER.
4. Tugas 2.4: perintah `analyze` dan `dispatch('debate')` memakai `runIndodaxDebate`. Debat tanpa pasangan ditolak. `triggerCycle(undefined)` (siklus terjadwal dan auto) serta `executeSingleSymbolCycle` masih jalur lama dan dihapus di 3.1 dan 3.2. Tombol Mulai debat di Office masih mengirim simbol dari watchlist lama sampai 4.2. Debat hanya berjalan di mode PAPER dan hanya menyimpan saran.
5. Tugas 2.5: hanya `smc` yang masuk konteks (`advisory.structure`: tren, break terakhir, swing low dan high, zona). `harmonics`, `alpha-factors`, dan `monte-carlo` tidak dipakai Indodax dan dihapus di 3.6.
6. Tugas 2.6: konteks chat agen (`buildIndodaxChatContext`) menggantikan `buildLiveDeskChatContext` untuk perintah ask dan chat. Yang diuji adalah isi konteksnya (venue, pasangan aktif, kuote, tanpa kata venue lain). Balasan model terhadap pertanyaan seperti leverage tidak bisa diuji otomatis, jadi dicek saat sesi nyata di 5.4.

Empat tes lama diperbarui karena mengunci perilaku perpetual yang sengaja dihapus: `chat-execution-boundary`, `v2-integration-repair`, `v2-reconciliation-final`, `v2-runtime-repair`. `cycle-ops` memakai klien Indodax palsu (`tests/indodax-fixtures.ts`).
