# Trading Agent Mpu Gandring (Indodax Spot)

<p align="center">
  <img src="web/public/mpu-gandring-logo.webp" alt="Trading Agent Mpu Gandring" width="240" />
</p>

**Six AI agents · Indodax Spot · PAPER / Bot-Managed SL (LIVE) · MIT**

Trading Agent Mpu Gandring adalah meja kerja virtual dengan enam agen AI yang menganalisis pasangan **Indodax spot** (IDR dan USDT), menjalankan sesi simulasi **PAPER**, serta memantau stop-loss yang dikelola bot (`BOT_MANAGED`) untuk aset spot yang diadopsi.

- **Satu venue**: Indodax spot (`OPEN_LONG`, `HOLD`, `CLOSE`). Tidak ada short, leverage, funding, atau order perpetual.
- **Dua mata uang quote**: pasangan `IDR` dan `USDT` dijaga terpisah tanpa konversi diam-diam.
- **Penyimpanan & Keamanan**: PostgreSQL 18 + AES-256-GCM vault dengan Docker secret terpisah.
- **Notifikasi**: Telegram (opsional, untuk laporan dan peringatan Desk Lead).

## Menjalankan dengan Docker (Disarankan)

Prasyarat: Docker Desktop aktif dengan Linux containers.

```powershell
docker compose --profile tools run --rm --no-deps init-secrets
docker compose up -d --build
```

Buka **http://127.0.0.1:8787**. Instalasi baru dimulai pada mode **PAPER** dengan Auto Trading mati.

Untuk pengembangan lokal di Windows (backend dan Vite berjalan di host, PostgreSQL 18 tetap di Docker):

```powershell
npm run dev:local
```

Lihat panduan lengkapnya di [Docker dan PostgreSQL 18](docs/docker-postgres.md).

## Penggunaan Dasar

1. Buka **Setup** (atau menu alat **AI**) untuk mengonfigurasi profil penyedia AI (OpenAI-compatible, Anthropic, atau CLI lokal seperti Codex / Claude Code).
2. Di bar perintah Office, pilih pasangan Indodax (misalnya `BTCIDR`, `ETHIDR`, `BTCUSDT`) lalu klik **Start debate** atau ketik `analyze BTCIDR`.
   - Debat di luar sesi PAPER hanya menyimpan saran (**Verdicts**) dan tidak membuka posisi simulasi.
3. Untuk simulasi perdagangan otomatis dengan saldo virtual, buka menu alat **Indodax** -> bagian **PAPER agent**.
4. Untuk pemantau stop-loss aset spot yang sudah Anda miliki, lihat [SL yang dijalankan bot](docs/indodax-bot-stops.md).

## Enam Peran Agen

| Peran | Tanggung Jawab |
| --- | --- |
| **Desk Lead** | Menimbang masukan analis dan menerbitkan satu verdict (`OPEN_LONG`, `HOLD`, atau `CLOSE`) |
| **Market Analyst** | Membaca candle 4h/1d Indodax, indikator EMA/RSI/ATR, dan struktur SMC |
| **Research Analyst** | Menilai katalis, kualitas data, dan kondisi risiko yang dapat memicu veto |
| **Strategist** | Menyusun skenario entry spot long-only, level invalidasi, dan argumen tandingan |
| **Risk Manager** | Menjaga batas rugi harian dan kelayakan eksekusi secara terpisah |
| **Execution Trader** | Memeriksa aturan pasangan Indodax, minimum order, dan kesiapan SL |

Detail alur debat, kontrak konteks, dan ketahanan penyedia dapat dibaca di [Panduan Debat Indodax](docs/indodax-debate.md).

## Dokumentasi

- [Data Pasar & Parameter Indodax](docs/indodax.md)
- [Panduan Debat Spot Indodax](docs/indodax-debate.md)
- [Pemantau SL yang Dijalankan Bot](docs/indodax-bot-stops.md)
- [Docker & PostgreSQL 18](docs/docker-postgres.md)
- [Log Sesi Diagnostik](docs/session-logs.md)
- [Changelog](CHANGELOG.md)
- [Lisensi MIT](LICENSE)

## Pengujian

Pengujian berjalan terisolasi menggunakan layanan `test` di Docker dengan PostgreSQL 18 terpisah:

```powershell
docker compose --profile test build test
docker compose --profile test run --rm test npm run typecheck
docker compose --profile test run --rm test npm test
docker compose --profile test stop test-database
```

## Lisensi & Atribusi

Proyek ini berlisensi [MIT](LICENSE), hak cipta penulis asli **Abrur Alaina**.
