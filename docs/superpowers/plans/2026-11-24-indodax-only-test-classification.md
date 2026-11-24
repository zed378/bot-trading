# Klasifikasi tes: proyek khusus Indodax

Hasil tugas 0.3 dari [rencana tugas](2026-11-24-indodax-only-plan.md). Pendamping [inventaris](2026-11-24-indodax-only-inventory.md).
Tanggal: 2026-11-24. Dasar: commit `e9a74f2` ditambah perbaikan `c6f5aab`.

## Cara label ditentukan

Label diturunkan dari impor langsung tiap berkas tes (termasuk lewat pembantu seperti `tests/fakes.ts`) ke berkas sumber, lalu dicocokkan dengan nasib tiap berkas sumber di inventaris:

| Label | Aturan | Arti |
| --- | --- | --- |
| pertahankan | semua impor adalah modul inti | Tetap dijalankan tanpa perubahan |
| tulis ulang | campuran modul yang dihapus dan yang dipertahankan, atau mengimpor modul yang ditulis ulang | Bagian venue lain dibuang, sisanya disesuaikan |
| tinjau | mengimpor modul yang nasibnya belum diputuskan (modul analisis di 2.5, `server/exchange/rules.ts`, skrip) | Diputuskan setelah tugas yang bersangkutan |
| hapus | semua impor adalah modul yang dihapus | Dihapus bersama sumbernya |

Kolom terkunci menandai tes yang melindungi pengaman di bagian 7 rancangan (nomor butir di kolom itu). Tes terkunci tidak boleh dihapus atau dilemahkan sebelum ada tes pengganti yang lulus untuk jalur Indodax (tugas 5.1).

Batas metode: ini penilaian dari impor, bukan dari isi tiap kasus uji. Label akhir tiap tes ditetapkan ulang oleh tugas yang menghapus atau mengubah sumbernya (3.2 sampai 3.8, 4.x), dengan membaca tesnya. Tes bertanda tulis ulang bisa berakhir hapus bila setelah pembersihan tidak ada yang tersisa untuk diuji.

## Ringkasan

Total 222 berkas tes (153 entri tingkat atas di `tests/` ditambah subfolder `tests/rebirth/`; angka 153 di rencana awal tidak menghitung subfolder).

| Label | Jumlah |
| --- | --- |
| pertahankan | 29 |
| tulis ulang | 91 |
| tinjau | 20 |
| hapus | 82 |

Tes terkunci (pengaman): 18 berkas.

## Pemetaan tes pengaman ke butir bagian 7

| Butir | Pengaman | Tes yang ada | Catatan |
| --- | --- | --- | --- |
| 1 | Kill switch | `rebirth/protection`, `rebirth/v2-runtime-repair`, `indodax-stops`, `killswitch-forensics` (desk lama) | Celah: tes sesi PAPER Indodax (`indodax-paper-agent`, `indodax-paper-fees`) hanya menyetel `killed: false`. Tidak ada kasus `killed: true` yang membuktikan siklus dan pemantau SL dan TP simulasi berhenti |
| 2 | Batas rugi harian | `rebirth/gateway`, `rebirth/v2-runtime-repair`, `daily-loss-recovery` (desk lama) | Celah: `enforceDailyLossCap` di `server/v2/api/indodax-paper.ts` tidak punya tes. `indodax-paper-agent.test.ts` tidak menyebut batas rugi |
| 3 | Izin kunci tanpa penarikan | `indodax-stops` | Tes venue lain (`rebirth/venue-*`, `aster-agent`, `dex`) dihapus bersama adaptornya |
| 4 | Konfirmasi LIVE | `setup` (desk lama), `rebirth/launcher`, `rebirth/setup-parity` | Celah: frasa `I understand LIVE trades real money` diperiksa di `server/v2/api/indodax-stops.ts`, tetapi `indodax-stops.test.ts` dan `postgres-integration.test.ts` tidak menguji penolakan tanpa frasa itu |
| 5 | Rahasia dan vault | `postgres-integration`, `redact`, `session-log`, `session-log-integration` | Dipertahankan |
| 6 | Loopback dan origin | `indodax`, `postgres-integration` (respons 403 untuk rute Indodax), `http-mutation-authorization` dan `final-owner-http` (desk lama) | Rute lain di `server/v2/office.ts` (paper-agent, providers) perlu diperiksa apakah punya tes 403 sendiri |
| 7 | Teks tidak tepercaya | `injection` (desk lama, memakai `server/untrusted.ts` yang dipertahankan), `rebirth/research` | Ditulis ulang untuk konteks Indodax |
| 8 dan 9 | SL dikelola bot dan jalur gateway | `indodax-stops`, `rebirth/gateway`, `rebirth/authority`, `rebirth/protection`, `postgres-integration` | Dipertahankan |

Tiga celah berlabel Celah di atas sudah ada sebelum perombakan dimulai. Keduanya ditambahkan ke tugas 5.1 sebagai tes baru, bukan hanya pemetaan.


## Pertahankan (29)

| Tes | Alasan | Terkunci |
| --- | --- | --- |
| conversation-creation-ui.test.ts | hanya mengimpor modul inti (web/src/useDesk.ts) |  |
| discussion.test.ts | hanya mengimpor modul inti (web/src/discussion.ts, web/src/types.ts) |  |
| formatted-text.test.ts | hanya mengimpor modul inti (web/src/formatText.tsx) |  |
| frontend-diagnostics.test.ts | hanya mengimpor modul inti (web/src/diagnostics.ts) |  |
| indodax-paper-fees.test.ts | hanya mengimpor modul inti (market/indodax.ts, v2/api/indodax-paper.ts dan 2 lain) |  |
| indodax-params.test.ts | hanya mengimpor modul inti (market/indodax-params.ts) |  |
| indodax-stops.test.ts | hanya mengimpor modul inti (redact.ts, v2/execution/gateway.ts dan 3 lain) | 1, 3, 5, 8, 9 |
| indodax.test.ts | hanya mengimpor modul inti (market/indodax.ts, v2/api/indodax.ts) | 6 |
| office-api.test.ts | hanya mengimpor modul inti (web/src/officeApi.ts) |  |
| postgres-integration.test.ts | hanya mengimpor modul inti (v2/agents/providers.ts, v2/api/indodax-stops.ts dan 8 lain) | 5, 6, 8 |
| rebirth/capital-transparency.test.ts | hanya mengimpor modul inti (v2/api/chat.ts, v2/office.ts) |  |
| rebirth/chat-persistence.test.ts | hanya mengimpor modul inti (v2/api/chat.ts, v2/store/database.ts) |  |
| rebirth/chat-repair.test.ts | hanya mengimpor modul inti (v2/api/chat.ts, v2/contracts.ts) |  |
| rebirth/chat-routing.test.ts | hanya mengimpor modul inti (v2/agents/runner.ts, v2/contracts.ts) |  |
| rebirth/debate.test.ts | hanya mengimpor modul inti (v2/agents/jev.ts, v2/agents/runner.ts dan 1 lain) |  |
| rebirth/decimal.test.ts | hanya mengimpor modul inti (v2/execution/decimal.ts) |  |
| rebirth/exits.test.ts | hanya mengimpor modul inti (v2/contracts.ts, v2/decision/exits.ts) |  |
| rebirth/jev.test.ts | hanya mengimpor modul inti (v2/agents/jev.ts, v2/agents/roles.ts) |  |
| rebirth/limit-gtc-geometry.test.ts | hanya mengimpor modul inti (v2/agents/runner.ts, v2/decision/cycle.ts) |  |
| rebirth/migration.test.ts | hanya mengimpor modul inti (v2/store/database.ts) |  |
| rebirth/mock-cycle-parity.test.ts | hanya mengimpor modul inti (v2/agents/mock.ts, v2/agents/providers.ts dan 2 lain) |  |
| rebirth/model-catalog.test.ts | hanya mengimpor modul inti (v2/settings/model-catalog.ts, v2/settings/schema.ts) |  |
| rebirth/reversal.test.ts | hanya mengimpor modul inti (v2/contracts.ts, v2/decision/revalidate.ts) |  |
| rebirth/settings.test.ts | hanya mengimpor modul inti (v2/settings/schema.ts, v2/settings/secrets.ts dan 2 lain) |  |
| rebirth/store.test.ts | hanya mengimpor modul inti (v2/contracts.ts, v2/store/database.ts dan 1 lain) |  |
| redact.test.ts | hanya mengimpor modul inti (redact.ts) | 5 |
| session-log.test.ts | hanya mengimpor modul inti (redact.ts, session-log.ts) | 5 |
| session-logs-ui.test.ts | hanya mengimpor modul inti (web/src/sessionLogsData.ts) |  |
| session-process.test.ts | hanya mengimpor modul inti (session-log.ts) |  |

## Tulis ulang (91)

| Tes | Alasan | Terkunci |
| --- | --- | --- |
| account-scope-memory.test.ts | mengimpor yang dihapus: config.ts, desk.ts dan 1 lain (3.2); yang ditulis ulang: money.ts (3.1) |  |
| activity-log.test.ts | mengimpor yang dihapus: activity.ts, app.ts dan 5 lain (3.2, 3.6); yang ditulis ulang: web/components/Panels.tsx (4.2) |  |
| activity-search.test.ts | mengimpor yang dihapus: config.ts, desk.ts dan 1 lain (3.2) |  |
| auto.test.ts | mengimpor yang dihapus: app.ts, auto.ts dan 8 lain (3.2, 3.5, 3.6) |  |
| channels.test.ts | mengimpor yang dihapus: app.ts, channels/adapters.ts dan 6 lain (3.2); yang ditulis ulang: cli/envfile.ts (4.3) |  |
| collaboration.test.ts | mengimpor yang dihapus: app.ts, collaboration.ts dan 5 lain (3.2, 3.6) |  |
| connect-upgrades.test.ts | mengimpor yang dihapus: app.ts, config.ts dan 1 lain (3.2); yang ditulis ulang: cli/envfile.ts (4.3) |  |
| data-source-settings.test.ts | mengimpor yang dihapus: config.ts, setup/data-sources.ts (3.2); yang ditulis ulang: cli/envfile.ts (4.3) |  |
| debate-contract-integration.test.ts | mengimpor yang dihapus: config.ts, decision/stale.ts dan 5 lain (3.2, 3.5, 3.6); yang ditulis ulang: strategy.ts (3.1); yang dikaji: decision/debate-evidence.ts (3.5) |  |
| debate-evidence.test.ts | mengimpor yang dihapus: market/microstructure.ts, market/news.ts dan 1 lain (3.6); yang dikaji: decision/debate-evidence.ts (3.5) |  |
| debate.test.ts | mengimpor yang dihapus: commands.ts, config.ts dan 3 lain (3.2, 3.6); yang ditulis ulang: strategy.ts (3.1) |  |
| decision-engine.test.ts | mengimpor yang dihapus: config.ts, decision/evaluation.ts dan 8 lain (3.2, 3.6); yang ditulis ulang: strategy.ts, trading-settings.ts (3.1) |  |
| desk-slot-display.test.ts | yang ditulis ulang: web/components/DeskOps.tsx (4.2) |  |
| evidence-learning.test.ts | mengimpor yang dihapus: config.ts, desk.ts dan 2 lain (3.2) |  |
| final-mission.test.ts | mengimpor yang dihapus: config.ts, desk.ts dan 5 lain (3.2, 3.5, 3.6) |  |
| financial-evidence.test.ts | mengimpor yang dihapus: config.ts, desk.ts dan 8 lain (3.2, 3.5, 3.6); yang dikaji: exchange/types.ts (3.5) |  |
| fixes.test.ts | mengimpor yang dihapus: cli/gb.ts, config.ts dan 8 lain (3.2, 3.5, 3.6); yang ditulis ulang: cli/unkill.ts, killswitch.ts dan 1 lain (4.3, 3.1); yang dikaji: exchange/rules.ts (3.5) |  |
| full-system-integration.test.ts | mengimpor yang dihapus: decision/adversarial-debate.ts, decision/jev-contracts.ts dan 6 lain (3.2, 3.5, 3.6); yang dikaji: exchange/types.ts, market/alpha-factors.ts dan 1 lain (3.5, 2.5) |  |
| gtc-desk.test.ts | mengimpor yang dihapus: app.ts, config.ts dan 2 lain (3.2, 3.6); yang dikaji: exchange/types.ts (3.5) |  |
| gtc-entry.test.ts | mengimpor yang dihapus: exchange/aster.ts, live/executor.ts (3.5, 3.2); yang dikaji: exchange/types.ts (3.5) |  |
| high-alpha-engine.test.ts | mengimpor yang dihapus: commands.ts, config.ts dan 3 lain (3.2); yang ditulis ulang: strategy.ts (3.1) |  |
| i18n.test.ts | mengimpor yang dihapus: exchange/index.ts, wallet.ts (3.5, 3.4); yang dikaji: updater.ts |  |
| incident-v046-remediation.test.ts | mengimpor yang dihapus: config.ts, decision/pace.ts dan 5 lain (3.2); yang ditulis ulang: strategy.ts (3.1); yang dikaji: decision/debate-evidence.ts (3.5) |  |
| indodax-paper-agent.test.ts | yang ditulis ulang: v2/runtime.ts (3.1) |  |
| injection.test.ts | menguji teks tidak tepercaya lewat desk lama; ditulis ulang untuk konteks Indodax (2.1 dan 5.2) | 7 |
| intelligence-upgrade.test.ts | mengimpor yang dihapus: config.ts, desk.ts dan 4 lain (3.2, 3.6); yang ditulis ulang: strategy.ts (3.1) |  |
| jev-setup.test.ts | mengimpor yang dihapus: app.ts, config.ts dan 1 lain (3.2); yang ditulis ulang: cli/envfile.ts (4.3) |  |
| killswitch-forensics.test.ts | menguji kill switch lewat server/app.ts lama; ditulis ulang untuk jalur v2 dan kill-file (tugas 4.3 dan 5.1) | 1 |
| learning.test.ts | mengimpor yang dihapus: auto.ts, config.ts dan 5 lain (3.2) |  |
| live-observations.test.ts | mengimpor yang dihapus: market/index.ts, market/observations.ts dan 2 lain (3.6); yang ditulis ulang: strategy.ts (3.1) |  |
| live.test.ts | mengimpor yang dihapus: config.ts, exchange/bybit.ts dan 6 lain (3.2, 3.5, 3.6); yang ditulis ulang: cli/doctor.ts (4.3) |  |
| local-agents.test.ts | mengimpor yang dihapus: config.ts, providers/local.ts dan 1 lain (3.2); yang ditulis ulang: cli/envfile.ts (4.3) |  |
| local-reasoning.test.ts | mengimpor yang dihapus: config.ts, providers/index.ts dan 3 lain (3.2); yang ditulis ulang: cli/envfile.ts (4.3) |  |
| market-integrity-provenance.test.ts | mengimpor yang dihapus: market/index.ts, market/microstructure.ts dan 2 lain (3.6); yang ditulis ulang: strategy.ts (3.1) |  |
| money.test.ts | mengimpor yang dihapus: paper.ts (3.2); yang ditulis ulang: money.ts (3.1) |  |
| mpu-cli.test.ts | mengimpor yang dihapus: channels/commands.ts, channels/discord.ts dan 1 lain (3.2); yang ditulis ulang: cli/envfile.ts, cli/kill.ts dan 2 lain (4.3) |  |
| office-settings-regressions.test.ts | mengimpor yang dihapus: app.ts, config.ts (3.2); yang ditulis ulang: cli/envfile.ts (4.3) |  |
| owner-commands.test.ts | mengimpor yang dihapus: app.ts, channels/commands.ts dan 10 lain (3.2, 3.5, 3.6); yang ditulis ulang: cli/envfile.ts, money.ts dan 1 lain (4.3, 3.1) |  |
| position-first-lifecycle.test.ts | mengimpor yang dihapus: auto.ts, config.ts dan 6 lain (3.2, 3.5, 3.6) |  |
| production-upgrades.test.ts | mengimpor yang dihapus: channels/adapters.ts, channels/config.ts dan 6 lain (3.2); yang ditulis ulang: cli/envfile.ts, money.ts dan 1 lain (4.3, 3.1) |  |
| protection.test.ts | mengimpor yang dihapus: exchange/aster.ts, exchange/binance.ts dan 6 lain (3.5, 3.2, 3.6); yang dikaji: exchange/types.ts (3.5) |  |
| qa-fixes.test.ts | mengimpor yang dihapus: cli/gb.ts, cli/trade.ts dan 5 lain (3.2, 3.5); yang dikaji: exchange/types.ts (3.5) |  |
| rebirth/adapter-contract.test.ts | yang ditulis ulang: v2/execution/adapters/types.ts (3.5) |  |
| rebirth/api-parity.test.ts | yang ditulis ulang: v2/runtime.ts (3.1) |  |
| rebirth/channel-commands-sync.test.ts | yang ditulis ulang: v2/api/setup.ts, v2/channels.ts dan 1 lain (3.1) |  |
| rebirth/channel-text.test.ts | yang ditulis ulang: v2/channel-text.ts, v2/reports.ts (3.1) |  |
| rebirth/channels.test.ts | yang ditulis ulang: v2/channels.ts (3.1) |  |
| rebirth/chat-execution-boundary.test.ts | yang ditulis ulang: v2/runtime.ts (3.1) |  |
| rebirth/cross-market-context.test.ts | yang ditulis ulang: v2/runtime.ts (3.1) |  |
| rebirth/cycle-ops.test.ts | yang ditulis ulang: v2/reports.ts, v2/runtime.ts (3.1) |  |
| rebirth/cycle-stance-reset.test.ts | yang ditulis ulang: v2/runtime.ts (3.1) |  |
| rebirth/fast-reflex-lifecycle.test.ts | mengimpor yang dihapus: cli/gb.ts, v2/market/opportunity.ts (3.2, 3.6); yang ditulis ulang: v2/runtime.ts (3.1); yang dikaji: v2/accounts/authority.ts, v2/accounts/registry.ts (3.5) |  |
| rebirth/indicators.test.ts | mengimpor yang dihapus: v2/market/intelligence.ts (3.6); yang dikaji: v2/market/indicators.ts (3.6) |  |
| rebirth/limit-gtc-execution.test.ts | mengimpor yang dihapus: v2/execution/adapters/bybit.ts (3.5); yang ditulis ulang: v2/execution/adapters/types.ts (3.5) |  |
| rebirth/local-agents.test.ts | yang ditulis ulang: v2/runtime.ts (3.1); yang dikaji: v2/accounts/registry.ts (3.5) |  |
| rebirth/office-browser.test.ts | yang ditulis ulang: v2/runtime.ts (3.1) |  |
| rebirth/opportunity-smc.test.ts | mengimpor yang dihapus: v2/market/opportunity.ts (3.6); yang dikaji: market/smc.ts (2.5) |  |
| rebirth/portfolio-sync.test.ts | yang ditulis ulang: v2/runtime.ts (3.1); yang dikaji: v2/accounts/registry.ts (3.5) |  |
| rebirth/runtime-isolation.test.ts | yang ditulis ulang: v2/runtime.ts (3.1); yang dikaji: scripts/check-runtime-boundary.mjs (4.6) |  |
| rebirth/sandbox.test.ts | mengimpor yang dihapus: research/pit.ts, v2/sandbox/backtest.ts (3.2, 3.5); yang ditulis ulang: v2/execution/adapters/types.ts (3.5); yang dikaji: v2/sandbox/paper.ts (3.5) |  |
| rebirth/setup-parity.test.ts | yang ditulis ulang: v2/runtime.ts (3.1); yang dikaji: v2/accounts/registry.ts (3.5) | 4 |
| rebirth/system.test.ts | yang ditulis ulang: v2/reports.ts, v2/runtime.ts (3.1); yang dikaji: v2/accounts/authority.ts, v2/accounts/registry.ts dan 1 lain (3.5) |  |
| rebirth/tradingview.test.ts | yang ditulis ulang: v2/runtime.ts (3.1); yang dikaji: v2/accounts/registry.ts (3.5) |  |
| rebirth/two-phase-cycle.test.ts | yang ditulis ulang: v2/runtime.ts (3.1) |  |
| rebirth/v2-integration-repair.test.ts | mengimpor yang dihapus: v2/execution/adapters/aster.ts (3.5); yang ditulis ulang: v2/execution/adapters/factory.ts (3.5); yang dikaji: v2/accounts/authority.ts, v2/accounts/registry.ts (3.5) |  |
| rebirth/v2-reconciliation-final.test.ts | yang ditulis ulang: v2/runtime.ts (3.1); yang dikaji: v2/accounts/authority.ts, v2/accounts/registry.ts (3.5) |  |
| rebirth/v2-runtime-repair.test.ts | yang ditulis ulang: cli/unkill.ts, killswitch.ts dan 1 lain (4.3, 3.1); yang dikaji: v2/accounts/authority.ts, v2/accounts/registry.ts (3.5) | 1, 2 |
| rebirth/venue-aster.test.ts | mengimpor yang dihapus: v2/execution/adapters/aster.ts (3.5); yang ditulis ulang: v2/execution/adapters/types.ts (3.5) |  |
| rebirth/venue-binance.test.ts | mengimpor yang dihapus: v2/execution/adapters/binance.ts (3.5); yang ditulis ulang: v2/execution/adapters/types.ts (3.5) |  |
| rebirth/venue-bybit.test.ts | mengimpor yang dihapus: v2/execution/adapters/bybit.ts (3.5); yang ditulis ulang: v2/execution/adapters/types.ts (3.5) |  |
| rebirth/venue-dydx.test.ts | mengimpor yang dihapus: v2/execution/adapters/dydx.ts (3.5); yang ditulis ulang: v2/execution/adapters/types.ts (3.5) |  |
| rebirth/venue-hyperliquid.test.ts | mengimpor yang dihapus: v2/execution/adapters/hyperliquid.ts (3.5); yang ditulis ulang: v2/execution/adapters/types.ts (3.5) |  |
| rebirth/venue-okx.test.ts | mengimpor yang dihapus: v2/execution/adapters/okx.ts (3.5); yang ditulis ulang: v2/execution/adapters/types.ts (3.5) |  |
| rebirth/venue-orderly.test.ts | mengimpor yang dihapus: v2/execution/adapters/orderly.ts (3.5); yang ditulis ulang: v2/execution/adapters/types.ts (3.5) |  |
| rebirth/venue-paradex.test.ts | mengimpor yang dihapus: v2/execution/adapters/paradex.ts (3.5); yang ditulis ulang: v2/execution/adapters/types.ts (3.5) |  |
| rebirth/wallet-routes.test.ts | mengimpor yang dihapus: v2/wallet.ts (3.4); yang ditulis ulang: v2/runtime.ts (3.1); yang dikaji: v2/accounts/registry.ts (3.5) |  |
| research-tools.test.ts | mengimpor yang dihapus: decision/collection.ts, decision/jev.ts dan 5 lain (3.2, 3.6); yang ditulis ulang: cli/envfile.ts (4.3) |  |
| resting-stop.test.ts | mengimpor yang dihapus: live/resting-stop.ts (3.2); yang dikaji: exchange/types.ts (3.5) |  |
| runtime-evidence.test.ts | mengimpor yang dihapus: app.ts, config.ts dan 4 lain (3.2, 3.5, 3.6); yang ditulis ulang: cli/envfile.ts, trading-settings.ts (4.3, 3.1) |  |
| scene-director.test.ts | mengimpor yang dihapus: config.ts, desk.ts dan 1 lain (3.2) |  |
| session-log-integration.test.ts | mengimpor yang dihapus: app.ts, config.ts dan 3 lain (3.2, 3.5, 3.6) | 5 |
| session-observers.test.ts | mengimpor yang dihapus: app.ts, config.ts dan 5 lain (3.2, 3.5, 3.6) |  |
| setup-docs.test.ts | mengimpor yang dihapus: setup/docs.ts (3.2); yang dikaji: exchange/types.ts (3.5) |  |
| setup-models.test.ts | mengimpor yang dihapus: app.ts, config.ts dan 3 lain (3.2); yang ditulis ulang: cli/envfile.ts (4.3) |  |
| setup.test.ts | menguji penolakan kunci dengan izin penarikan dan frasa LIVE lewat setup venue lama; ditulis ulang untuk Indodax (4.3) | 3, 4 |
| sizing.test.ts | mengimpor yang dihapus: exchange/aster.ts (3.5); yang ditulis ulang: money.ts (3.1); yang dikaji: exchange/rules.ts (3.5) |  |
| strategy-momentum-contract.test.ts | mengimpor yang dihapus: decision/stale.ts (3.2); yang ditulis ulang: strategy.ts (3.1) |  |
| support-popup.test.ts | mengimpor yang dihapus: app.ts, config.ts (3.2); yang ditulis ulang: web/components/Panels.tsx (4.2) |  |
| tactical.test.ts | mengimpor yang dihapus: market/tactical.ts (3.6); yang ditulis ulang: strategy.ts (3.1) |  |
| trading-behavior-regressions.test.ts | mengimpor yang dihapus: agents/run.ts, config.ts dan 6 lain (3.2, 3.6); yang ditulis ulang: cli/envfile.ts, money.ts dan 1 lain (4.3, 3.1) |  |
| trading-settings.test.ts | mengimpor yang dihapus: cli/gb.ts, app.ts dan 8 lain (3.2, 3.5, 3.6); yang ditulis ulang: cli/envfile.ts, trading-settings.ts (4.3, 3.1) |  |

## Tinjau (20)

| Tes | Alasan | Terkunci |
| --- | --- | --- |
| alpha-factors.test.ts | yang dikaji: market/alpha-factors.ts (2.5) |  |
| body-parser-regression.test.ts | memulai proses server lewat spawn dan tidak mengimpor sumber; dikaji setelah impor server dipangkas |  |
| harmonics.test.ts | yang dikaji: market/harmonics.ts (2.5) |  |
| live-record-audit.test.ts | yang dikaji: scripts/audit-live-records.ts (4.6) |  |
| low-price-structure.test.ts | yang dikaji: market/harmonics.ts, market/smc.ts (2.5) |  |
| rebirth/accounts.test.ts | yang dikaji: v2/accounts/authority.ts, v2/accounts/registry.ts (3.5) |  |
| rebirth/authority.test.ts | yang dikaji: v2/accounts/authority.ts, v2/accounts/registry.ts (3.5) | 8, 9 |
| rebirth/baseline.test.ts | yang dikaji: scripts/rebirth-contracts.mjs (4.6) |  |
| rebirth/cli.test.ts | yang dikaji: cli/v2/doctor.ts, cli/v2/main.ts (4.3) |  |
| rebirth/gateway.test.ts | yang dikaji: v2/accounts/authority.ts, v2/accounts/registry.ts (3.5) | 2, 8, 9 |
| rebirth/launcher.test.ts | yang dikaji: cli/v2/setup.ts (4.3) | 4 |
| rebirth/learning.test.ts | yang dikaji: v2/learning.ts (3.5) |  |
| rebirth/news-routing.test.ts | yang dikaji: v2/research/host.ts (3.5) |  |
| rebirth/protection.test.ts | yang dikaji: v2/accounts/authority.ts, v2/accounts/registry.ts (3.5) | 1, 8, 9 |
| rebirth/provider-tools.test.ts | yang dikaji: v2/research/host.ts (3.5) |  |
| rebirth/research.test.ts | yang dikaji: cli/v2/research-mcp.ts, v2/research/browser-worker.ts dan 2 lain (4.3, 3.5) |  |
| rebirth/roles.test.ts | yang dikaji: v2/research/host.ts (3.5) |  |
| rebirth/tool-security.test.ts | yang dikaji: v2/research/browser-worker.ts, v2/research/host.ts (3.5) |  |
| smc.test.ts | yang dikaji: market/smc.ts (2.5) |  |
| stage-gate.test.ts | menguji scripts/mpu-gate.mjs; dikaji bersama skrip |  |

## Hapus (82)

| Tes | Alasan | Terkunci |
| --- | --- | --- |
| adversarial-debate.test.ts | mengimpor yang dihapus: decision/adversarial-debate.ts (3.2) |  |
| agent-failure-classification.test.ts | mengimpor yang dihapus: agents/run.ts, config.ts dan 1 lain (3.2) |  |
| agent-queue.test.ts | mengimpor yang dihapus: providers/work-queue.ts (3.2) |  |
| agent-schemas-nullish.test.ts | mengimpor yang dihapus: schemas.ts (3.2) |  |
| archetypes.test.ts | mengimpor yang dihapus: agents/archetypes.ts, agents/roles.ts (3.2) |  |
| aster-agent.test.ts | mengimpor yang dihapus: exchange/aster.ts, exchange/dydx.ts dan 1 lain (3.5, 3.2) |  |
| autonomous-exits-freedom.test.ts | mengimpor yang dihapus: app.ts, config.ts dan 4 lain (3.2, 3.6) |  |
| backtest.test.ts | mengimpor yang dihapus: research/backtest.ts, research/pit.ts (3.2) |  |
| bridge.test.ts | mengimpor yang dihapus: bridge.ts, config.ts (3.2) |  |
| calibration.test.ts | mengimpor yang dihapus: decision/calibration.ts (3.2) |  |
| capabilities.test.ts | mengimpor yang dihapus: collaboration.ts, config.ts dan 3 lain (3.2) |  |
| channel-reports.test.ts | mengimpor yang dihapus: channels/adapters.ts, channels/commands.ts dan 4 lain (3.2) |  |
| chart-candles.test.ts | mengimpor yang dihapus: app.ts, config.ts dan 1 lain (3.2, 3.6) |  |
| chat-operational-reliability.test.ts | mengimpor yang dihapus: config.ts, desk.ts dan 1 lain (3.2) |  |
| chat-reliability.test.ts | mengimpor yang dihapus: config.ts, desk.ts dan 1 lain (3.2) |  |
| coinmarketcap.test.ts | mengimpor yang dihapus: market/coinmarketcap.ts (3.6) |  |
| config.test.ts | mengimpor yang dihapus: config.ts (3.2) |  |
| conversation-continuity.test.ts | mengimpor yang dihapus: app.ts, config.ts dan 2 lain (3.2) |  |
| daily-loss-recovery.test.ts | menguji batas rugi harian di desk lama; dihapus hanya setelah ada tes pengganti untuk jalur Indodax (5.1) | 2 |
| debate-critical-path.test.ts | mengimpor yang dihapus: config.ts, desk.ts dan 2 lain (3.2, 3.6) |  |
| debate-pacing.test.ts | mengimpor yang dihapus: auto.ts, config.ts dan 2 lain (3.2) |  |
| dex.test.ts | mengimpor yang dihapus: exchange/aster.ts, exchange/dydx.ts dan 4 lain (3.5, 3.2) |  |
| dynamic-roi.test.ts | mengimpor yang dihapus: research/backtest.ts, research/pit.ts dan 2 lain (3.2) |  |
| event-bus.test.ts | mengimpor yang dihapus: events/event-bus.ts (3.2) |  |
| evidence-integrity.test.ts | mengimpor yang dihapus: market/index.ts, market/news.ts dan 1 lain (3.6) |  |
| execution-recovery.test.ts | mengimpor yang dihapus: config.ts, desk.ts dan 4 lain (3.2, 3.5, 3.6) |  |
| external-agent-parity.test.ts | mengimpor yang dihapus: cli/gb.ts, app.ts dan 4 lain (3.2, 3.5, 3.6) |  |
| final-owner-http.test.ts | menguji akses Owner lokal di server/app.ts lama; dihapus hanya setelah pengganti (5.1) | 6 |
| financial-history.test.ts | mengimpor yang dihapus: exchange/aster.ts, exchange/bybit.ts (3.5) |  |
| gb-capabilities.test.ts | mengimpor yang dihapus: cli/gb.ts (3.2) |  |
| gb-evidence.test.ts | mengimpor yang dihapus: cli/gb.ts, market/index.ts (3.2, 3.6) |  |
| gb-regressions.test.ts | mengimpor yang dihapus: cli/gb.ts, app.ts dan 5 lain (3.2, 3.5, 3.6) |  |
| gb.test.ts | mengimpor yang dihapus: cli/gb.ts, app.ts dan 5 lain (3.2, 3.5, 3.6) |  |
| gtc-cli.test.ts | mengimpor yang dihapus: cli/gb.ts, schemas.ts (3.2) |  |
| http-mutation-authorization.test.ts | menguji otorisasi loopback dan origin di server/app.ts lama; dihapus hanya setelah pengganti untuk rute v2 (5.1) | 6, 7 |
| inventory-skew.test.ts | mengimpor yang dihapus: live/inventory-skew.ts (3.2) |  |
| jev-adapter.test.ts | mengimpor yang dihapus: decision/jev.ts, decision/schemas.ts (3.2) |  |
| jev-contracts.test.ts | mengimpor yang dihapus: decision/jev-contracts.ts (3.2) |  |
| jev-intelligence.test.ts | mengimpor yang dihapus: config.ts, decision/evaluation.ts dan 2 lain (3.2) |  |
| jev-provenance.test.ts | mengimpor yang dihapus: decision/evaluation.ts, decision/jev.ts dan 1 lain (3.2) |  |
| kronos-client.test.ts | mengimpor yang dihapus: market/kronos-client.ts (3.6) |  |
| kronos-worker.test.ts | menguji workers/kronos (Python), data pasar venue lain |  |
| local-agent-login.test.ts | mengimpor yang dihapus: providers/local.ts (3.2) |  |
| microstructure.test.ts | mengimpor yang dihapus: market/index.ts, market/microstructure.ts (3.6) |  |
| model-stack-v0320.test.ts | mengimpor yang dihapus: cli/bench-models.ts, agents/run.ts dan 3 lain (3.2) |  |
| modes.test.ts | mengimpor yang dihapus: app.ts, config.ts dan 5 lain (3.2, 3.5, 3.6) |  |
| monte-carlo.test.ts | mengimpor yang dihapus: market/monte-carlo.ts (3.6) |  |
| native-market-priority.test.ts | mengimpor yang dihapus: market/index.ts (3.6) |  |
| news-onchain-v0320.test.ts | mengimpor yang dihapus: market/live-news.ts, market/sui.ts dan 1 lain (3.6) |  |
| opportunity-review.test.ts | mengimpor yang dihapus: market/sample.ts, opportunity-review.ts (3.6, 3.2) |  |
| pit.test.ts | mengimpor yang dihapus: research/pit.ts (3.2) |  |
| positioning.test.ts | mengimpor yang dihapus: market/positioning.ts (3.6) |  |
| precision.test.ts | mengimpor yang dihapus: exchange/precision.ts (3.5) |  |
| private-chat-sessions.test.ts | mengimpor yang dihapus: config.ts, desk.ts dan 1 lain (3.2) |  |
| provider-runtime-regressions.test.ts | mengimpor yang dihapus: agents/run.ts, config.ts dan 2 lain (3.2) |  |
| rebirth/bybit.test.ts | mengimpor yang dihapus: v2/market/bybit.ts, v2/market/instruments.ts (3.6) |  |
| rebirth/ccxt.test.ts | mengimpor yang dihapus: v2/market/ccxt.ts (3.6) |  |
| rebirth/grok-auth.test.ts | mengimpor yang dihapus: v2/connectors/grok/auth.ts (3.3) |  |
| rebirth/grok-bridge.test.ts | mengimpor yang dihapus: v2/connectors/grok/bridge.ts, v2/connectors/grok/protocol.ts (3.3) |  |
| rebirth/grok-owner.test.ts | mengimpor yang dihapus: v2/connectors/grok/commands.ts (3.3) |  |
| rebirth/grok-protocol.test.ts | mengimpor yang dihapus: v2/connectors/grok/protocol.ts (3.3) |  |
| rebirth/grok-role-routing.test.ts | mengimpor yang dihapus: v2/connectors/grok/bridge.ts (3.3) |  |
| rebirth/handover.test.ts | mengimpor yang dihapus: v2/connectors/grok/commands.ts (3.3) |  |
| rebirth/solidity-consumer.test.ts | mengimpor yang dihapus: v2/wallet/registry-consumer.ts (3.4) |  |
| rebirth/stop.test.ts | mengimpor yang dihapus: v2/connectors/grok/commands.ts (3.3) |  |
| rebirth/wallet.test.ts | mengimpor yang dihapus: v2/wallet.ts (3.4) |  |
| rebirth/whale-intelligence.test.ts | mengimpor yang dihapus: v2/market/whale.ts (3.6) |  |
| rejection-cache.test.ts | mengimpor yang dihapus: decision/rejection-cache.ts (3.2) |  |
| report-summary.test.ts | mengimpor yang dihapus: config.ts, desk.ts dan 2 lain (3.2) |  |
| research-backtest-api.test.ts | mengimpor yang dihapus: config.ts, desk.ts dan 2 lain (3.2) |  |
| research-repair.test.ts | mengimpor yang dihapus: agents/run.ts, config.ts dan 3 lain (3.2) |  |
| risk.test.ts | mengimpor yang dihapus: config.ts, risk.ts (3.2) |  |
| runtime-recovery.test.ts | mengimpor yang dihapus: agents/roles.ts, agents/run.ts dan 7 lain (3.2, 3.5) |  |
| runtime-scope-isolation.test.ts | mengimpor yang dihapus: config.ts, desk.ts dan 4 lain (3.2, 3.5, 3.6) |  |
| schema.test.ts | mengimpor yang dihapus: agents/run.ts, config.ts dan 2 lain (3.2) |  |
| six-agent-roster.test.ts | mengimpor yang dihapus: agents/roles.ts, config.ts (3.2) |  |
| supervisor-sync.test.ts | mengimpor yang dihapus: channels/supervisor-sync.ts (3.2) |  |
| trade.test.ts | mengimpor yang dihapus: cli/autostart.ts, cli/trade.ts (3.2) |  |
| upgrade-workflow.test.ts | mengimpor yang dihapus: auto.ts, config.ts dan 4 lain (3.2) |  |
| wallet-session.test.ts | mengimpor yang dihapus: web/walletSession.ts (4.1) |  |
| wallet.test.ts | mengimpor yang dihapus: app.ts, config.ts dan 1 lain (3.2, 3.4) |  |
| windows-journal-recovery.test.ts | mengimpor yang dihapus: exchange/index.ts, live/executor.ts dan 2 lain (3.5, 3.2, 3.6) |  |
