# Inventaris: proyek khusus Indodax

Hasil tugas 0.2 (graf impor) dan 0.4 (baseline) dari [rencana tugas](2026-11-24-indodax-only-plan.md).
Tanggal: 2026-11-24. Dasar: commit `e9a74f2` (tag `pre-indodax-only`).
Bagian untuk tugas 0.3 (klasifikasi tes) belum diisi.

## 1. Cara graf dibuat

Skrip Node membaca semua berkas `.ts`, `.tsx`, `.mts`, `.mjs`, `.js` di `server`, `web/src`, `cli`, `shared`, `workers`, `scripts`, dan `bin` (299 berkas). Impor statis, `export ... from`, `import()` dinamis, dan `require()` dengan jalur relatif diikuti. Berkas dihitung terjangkau bila ada rantai impor dari salah satu titik masuk.

Titik masuk yang dianggap hidup (inti): `server/index.ts`, `cli/indodax.ts`, `cli/indodax-stops.ts`, `cli/migrate-postgres.ts`, `web/src/main.tsx`.

Batas metode, supaya hasilnya tidak dibaca lebih dari yang dibuktikannya:

1. Folder `tests/` tidak ikut dihitung. Sebuah berkas yang tampak yatim bisa saja masih dipakai tes (klasifikasi tes ada di tugas 0.3).
2. `cli/session-entry.ts` memuat berkas `cli/<perintah>.ts` dengan nama yang dihitung saat berjalan, jadi graf statis tidak melihat hubungannya. Karena itu semua berkas `cli/*` selain tiga CLI Indodax diperlakukan sebagai titik masuk sendiri.
3. Berkas non-kode yang dibaca saat berjalan tidak terlihat: persona agen (`server/v2/agents/personas/*`), `skills/`, `workers/`, `data/sample`. Dockerfile menyalin ketiganya ke image.
4. Impor dengan jalur dihitung (`import(variabel)`) tidak diikuti.

## 2. Hasil ringkas

| Kelompok | Jumlah berkas | Arti |
| --- | --- | --- |
| Inti | 162 | Terjangkau dari titik masuk yang hidup |
| Hanya lewat titik masuk lain | 117 | CLI selain Indodax, `scripts/*`, `bin/mpu.mjs`, dan seluruh sistem desk lama |
| Tidak terjangkau sama sekali | 20 | Kode mati hari ini |

## 3. Koreksi terhadap hipotesis di rancangan

Hipotesis bagian 4.2 rancangan ditulis dari nama berkas. Graf memberi tujuh koreksi. Rancangan dan rencana diperbarui sesuai tabel ini.

| No | Hipotesis | Temuan graf | Akibat pada rencana |
| --- | --- | --- | --- |
| 1 | Sistem desk lama (`desk.ts`, `app.ts`, `auto.ts`, `scan.ts`, `paper.ts`, `sizing.ts`, `risk.ts`, `commands.ts`, `config.ts`, `runtime.ts` dan sekitarnya) dihapus bersama `money.ts`, `strategy.ts`, `trading-settings.ts` | Benar untuk 22 berkas di `server/` yang hanya terjangkau lewat titik masuk lain, ditambah `server/runtime.ts` yang tidak terjangkau sama sekali. Tidak benar untuk `money.ts`, `strategy.ts`, `trading-settings.ts`, `types.ts`, `untrusted.ts`, `updater.ts`: keenamnya terjangkau dari `server/v2/runtime.ts` | Tugas 3.2 menghapus desk lama dengan aman karena memang tidak terhubung ke jalur hidup. `money.ts`, `strategy.ts`, `trading-settings.ts` tidak dihapus di 3.2. Bagian yang masih dipakai v2 dipindah dulu di 3.1 |
| 2 | `server/exchange/*` dihapus | Sepuluh berkas venue dan `financial-history.ts` hanya terjangkau lewat titik masuk lain. `rules.ts` dan `types.ts` terjangkau dari jalur hidup | Tugas 3.5 menghapus sepuluh berkas itu setelah 3.2. `rules.ts` dan `types.ts` dicek apakah Indodax memerlukannya |
| 3 | Adaptor di `server/v2/execution/adapters/*` hanya tersisa sebagai kode kandidat hapus | Kedelapan adaptor venue masih terjangkau lewat `factory.ts` dari jalur hidup | Tugas 3.5 harus memangkas `factory.ts` dan `gateway.ts` lebih dulu, baru menghapus adaptor |
| 4 | Data pasar perpetual dihapus | `server/market/index.ts` (hub) menarik `coinmarketcap`, `positioning`, `microstructure`, `whale`, `news`, `live-news`, `tactical`, `observations`, `sample`, `alpha-factors`, `harmonics`, `smc`, dan di `server/v2/market/` `bybit`, `whale`, `intelligence`, `opportunity`, `orderbook`, `instruments`, `candles`, `indicators` ke jalur hidup. `sui.ts` hanya lewat titik masuk lain. `kronos-client.ts`, `monte-carlo.ts`, `v2/market/ccxt.ts` tidak terjangkau | Tugas 3.6 harus memutus impor di `server/v2/runtime.ts` dan hub `server/market/index.ts` sebelum file dihapus. Tiga berkas yang sudah mati dihapus lebih awal di langkah pertama 3.6 |
| 5 | Kanal chat: `server/channels/*` dan `server/v2/channels.ts` dipangkas ke Telegram | `server/channels/*` (9 berkas) hanya lewat titik masuk lain. Yang hidup adalah `server/v2/channels.ts`, `channel-text.ts`, dan bagian di `runtime.ts` dan `api/setup.ts` | Tugas 3.3 menjadi lebih kecil: `server/channels/*` dihapus utuh. Pemangkasan ke Telegram hanya di `server/v2/channels.ts` (1365 baris), `channel-text.ts`, `runtime.ts`, `api/setup.ts`, dan `server/v2/reports.ts` |
| 6 | Wallet dihapus | `server/wallet.ts` hanya lewat titik masuk lain. `server/v2/wallet.ts`, `api/wallet.ts`, `web/src/walletSession.ts`, `Wallet.tsx`, `WalletMenu.tsx` terjangkau. `v2/wallet/registry-consumer.ts` tidak terjangkau | Tugas 3.4 menghapus `server/wallet.ts` dan `registry-consumer.ts` langsung. Sisanya mengikuti pemutusan impor di runtime dan web |
| 7 | `server/v2/research/browser-worker.ts` dikaji | `host.ts`, `provenance.ts`, `browser-worker.ts` terjangkau. `server/research/*` (6 berkas) dan `server/research/mcp.ts` tidak | Keputusan tetap di 3.5. `server/research/*` dihapus di 3.2 |

Temuan tambahan yang tidak ada di hipotesis: `server/v2/learning.ts`, `server/v2/connectors/commands.ts`, `server/v2/sandbox/backtest.ts`, `server/events/event-bus.ts`, `server/live/inventory-skew.ts`, `server/live/resting-stop.ts`, dan `server/decision/jev-contracts.ts` tidak terjangkau dari mana pun hari ini.

## 4. Daftar per kelompok

### 4.1 Tidak terjangkau sama sekali (20)

Kandidat hapus pertama, paling rendah risikonya. Setiap berkas dicek terhadap `tests/` di tugas 0.3 sebelum dihapus.

`server/runtime.ts`, `server/agents/archetypes.ts`, `server/channels/supervisor-sync.ts`, `server/decision/adversarial-debate.ts`, `server/decision/calibration.ts`, `server/decision/jev-contracts.ts`, `server/decision/rejection-cache.ts`, `server/events/event-bus.ts`, `server/exchange/precision.ts`, `server/live/inventory-skew.ts`, `server/live/resting-stop.ts`, `server/market/kronos-client.ts`, `server/market/monte-carlo.ts`, `server/research/mcp.ts`, `server/v2/learning.ts`, `server/v2/connectors/commands.ts`, `server/v2/market/ccxt.ts`, `server/v2/sandbox/backtest.ts`, `server/v2/wallet/registry-consumer.ts`, `web/src/vite-env.d.ts` (tipe Vite, dipertahankan).

### 4.2 Hanya lewat titik masuk lain (117)

Terhubung ke jalur hidup hanya lewat CLI, skrip, atau `bin/mpu.mjs`. Berarti menghapus CLI dan skrip yang bersangkutan sekaligus melepas berkas-berkas ini.

| Lokasi | Jumlah | Isi |
| --- | --- | --- |
| `cli/*` | 16 | autostart, backtest, bench-models, channels, debate, doctor, envfile, gb, kill, office-status, prompt, session-entry, setup, trade, unkill, version |
| `cli/v2/*` | 5 | client, doctor, main, research-mcp, setup |
| `scripts/*` | 13 | audit-live-records, check-runtime-boundary, gen-setup-docs, mpu-gate, office-preview, preview-office, rebirth-contracts, screenshot, verify-dashboard, verify-final-chat-ui, verify-office-ui, verify-session-logging, verify-wallet-contract |
| `bin/mpu.mjs` | 1 | peluncur `mpu` |
| `server/*.ts` | 22 | activity, app, auto, bridge, collaboration, commands, config, desk, killswitch, learnings, opportunity-review, paper, personal-chat, reports, risk, runtime-evidence, scan, schemas, scorecard, session-log-routes, sizing, wallet |
| `server/agents/*` | 3 | roles, run, speech |
| `server/channels/*` | 9 | adapters, commands, config, discord, guide, routes, setup, supervisor, verify |
| `server/decision/*` | 8 | collection, evaluation, jev, pace, reasons, schemas, stale, timing |
| `server/exchange/*` | 10 | aster, binance, bybit, dydx, financial-history, hyperliquid, index, okx, orderly, paradex |
| `server/live/*` | 6 | executor, financial-evidence, guard, journal, steps, testnet |
| `server/market/sui.ts` | 1 | |
| `server/providers/*` | 7 | capabilities, index, local, mock, reasoning, research-policy, work-queue |
| `server/research/*` | 6 | backtest, catalog, pit, roi-matrix, routes, trailing-stop |
| `server/setup/*` | 10 | core, data-sources, docs, doctor, guide, jev, models, preferences, routes, trading |

Perhatian: `server/killswitch.ts` ada di kelompok ini, padahal kill switch harus tetap ada (bagian 7 rancangan). Jalur hidup memakai `server/v2/kill-file.ts`. `server/killswitch.ts` dipakai oleh `server/desk.ts` dan CLI `kill`/`unkill` lewat titik masuk lain. Tugas 4.3 harus memastikan CLI `kill` dan `unkill` yang baru memakai jalur v2, sebelum `server/killswitch.ts` dihapus.

### 4.3 Inti (162)

Pecahan terhadap rancangan:

| Lokasi | Jumlah | Penilaian awal |
| --- | --- | --- |
| `cli/*` (tiga CLI Indodax dan migrasi) | 3 | Dipertahankan |
| `server/*.ts` (index, session-entry, session-log, redact, untrusted, updater, types, money, strategy, trading-settings) | 10 | `index`, `session-entry`, `session-log`, `redact`, `untrusted`, `types` dipertahankan (types dipangkas di 3.7). `money`, `strategy`, `trading-settings` dipecah di 3.1. `updater` dikaji (pembaruan dari upstream tidak lagi relevan) |
| `server/exchange/{rules,types}.ts`, `server/decision/debate-evidence.ts` | 3 | Dikaji di 3.5 |
| `server/market/*` | 16 | `indodax.ts`, `indodax-params.ts`, `provenance.ts` dipertahankan. `alpha-factors`, `harmonics`, `smc` menunggu 2.5. Sisanya (`coinmarketcap`, `positioning`, `microstructure`, `whale`, `news`, `live-news`, `tactical`, `observations`, `sample`, `index`) dikaji di 3.6 |
| `server/v2/*` | 9 | `contracts`, `kill-file`, `office`, `app`, `runtime` dipertahankan (runtime dipecah di 3.1). `channels`, `channel-text` dipangkas ke Telegram. `wallet.ts` dihapus. `reports.ts` dikaji |
| `server/v2/accounts/*` | 2 | Dikaji di 3.5 |
| `server/v2/agents/*` | 6 | Dipertahankan |
| `server/v2/api/*` | 13 | `indodax*`, `provider-profiles`, `chat`, `history`, `operations`, `state`, `local-agents`, `research`, `setup` dipertahankan atau dipangkas. `grok.ts` dan `wallet.ts` dihapus |
| `server/v2/connectors/*` | 3 | Dihapus (jembatan Grok Bot) |
| `server/v2/decision/*` | 3 | Dipertahankan, ditulis ulang di fase 2 |
| `server/v2/execution/*` | 16 | `indodax-client`, `indodax-stops`, `gateway`, `protection`, `reconcile`, `decimal` dipertahankan. Delapan adaptor venue, `factory`, `types` dipangkas atau dihapus di 3.5 |
| `server/v2/market/*` | 8 | `candles`, `indicators` dikaji. Enam lainnya dihapus di 3.6 |
| `server/v2/research/*` | 3 | Dikaji di 3.5 |
| `server/v2/sandbox/paper.ts` | 1 | Dikaji. Sesi PAPER Indodax punya state sendiri di `api/indodax-paper.ts` |
| `server/v2/settings/*` | 6 | Dipertahankan (skema dipangkas di 3.7) |
| `server/v2/setup/guide.ts` | 1 | Dikaji di 4.3 |
| `server/v2/store/*` | 6 | `database`, `errors`, `events`, `schema` dipertahankan. `import-sqlite` dan `sqlite-test-store` diputuskan di 3.4 |
| `shared/*` | 3 | `indodax`, `office` dipertahankan. `jev-models` dikaji |
| `web/src/*` (tingkat atas) | 15 | `walletSession.ts` dihapus. Sisanya dipertahankan atau dipangkas |
| `web/src/components/*` | 30 | `Wallet`, `WalletMenu`, `Channels`, `TradingViewChart`, `DataSourcesSetup`, `CodexResearchSetup` kandidat hapus. `Panels`, `DeskOps`, `TradingSetup`, `Setup`, `PriceChart`, `MiniCharts` dirancang ulang di 4.2 |
| `web/src/integrations/*` | 5 | Dipertahankan |

Daftar lengkap per berkas ada di keluaran skrip graf (lihat bagian 6).

## 5. Baseline sebelum perombakan (tugas 0.4)

Dijalankan lewat layanan `test` di Docker (Node 26, database uji PostgreSQL 18 terpisah dari database aplikasi), pada commit `e9a74f2` (tag `pre-indodax-only`).

| Gerbang | Hasil pada tag |
| --- | --- |
| Build image (`npm run build`: `tsc` server dan `vite build`) | Lulus |
| `npm run typecheck` (server, web, rebirth) | Lulus |
| `npm test` | 1 tes gagal dari 1545 (221 dari 222 berkas lulus) |

Kegagalan pada tag adalah regresi dari commit `9089998` (diagnostik alasan kegagalan role): `tests/indodax-paper-agent.test.ts`, kasus "routes a paper request through the configured cycle runner with spot-only policy". Runner palsu di tes itu tidak mengembalikan `roleResults`, sedangkan kode memanggil `.filter` padanya (`server/v2/runtime.ts`, `TypeError: Cannot read properties of undefined`). Commit itu dibuat tanpa menjalankan tes. Perbaikannya satu baris (`(out.roleResults ?? [])`) dan dikerjakan di cabang `indodax-only`.

Satu run awal tercemar: dua run berjalan bersamaan pada database uji yang sama (job pertama yang saya kira mati ternyata terus berjalan). Run itu menambah satu kegagalan waktu, `tests/incident-v046-remediation.test.ts`, kasus "runs initial analyst opinions concurrently in runDebate". Kegagalan itu tidak muncul di run bersih, jadi dicatat sebagai tes yang peka terhadap beban, bukan kegagalan baseline.

Setelah perbaikan (cabang `indodax-only`, run tunggal bersih): 222 berkas dan 1545 tes lulus, 106,7 detik. Angka inilah baseline yang dipakai gerbang fase 0 sampai 6.

Ukuran image Docker untuk tugas 4.4: `trading-agent-mpu-gandring-app` 2,76 GB dan `trading-agent-mpu-gandring-test` 2,14 GB. Image `app` dibangun sebelum perbaikan di atas, jadi angkanya pembanding kasar. Image ini memuat Chromium, `bubblewrap`, dan `@openai/codex` global (lihat `Dockerfile`), yang menjadi bahan keputusan di tugas 3.5 dan 4.4.

Catatan lingkungan: tumpukan `app`, `database`, `gateway` dalam keadaan `Exited` sejak sekitar 18 jam sebelum pengukuran ini. Saya tidak menyalakannya dan tidak mengubah database aplikasi.

## 6. Reproduksi

Skrip graf: `import-graph.mjs` (di folder kerja sementara, tidak di repo). Dijalankan dengan `node import-graph.mjs <akar repo> <berkas keluaran>`. Bila Owner ingin skrip ini disimpan di repo (misalnya `scripts/import-graph.mjs`), itu keputusan terpisah.
