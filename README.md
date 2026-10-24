# HGY bot – HEGEMONY Telegram Mini App

Pixel World clan tracker (@HGYinfo_bot) for clan HEGEMONY (team 5).

- `index.html` – the Telegram Mini App (single file)
- `worker/hegemony-members-worker.js` – Cloudflare Worker handler for `/api/clans/5/members?range=month|week`

## Yayınlama (Cloudflare Pages)

1. Cloudflare dashboard → Workers & Pages → Create → Pages → **Connect to Git** → `hgybot` reposunu seç.
2. Build ayarları: Framework yok, build command boş, output directory `/`. Deploy.
3. Çıkan adresi (ör. `https://hgybot.pages.dev`) BotFather'da ayarla: `/mybots` → bot → Bot Settings → **Configure Mini App** (veya Menu Button) → URL.
4. Bundan sonra GitHub'a her push otomatik yayınlanır.

## API (/api)

Uygulama verileri aynı alan adındaki `/api` yolundan çeker. Mevcut Cloudflare Worker'ını bu alan adına `/api/*` route'u ile bağla
ve `worker/hegemony-members-worker.js` dosyasını içine ekle (dosyanın sonundaki kullanım notuna bak).

Gizli bilgiler **asla** bu repoya yazılmaz (repo herkese açık). pw.game oturumunu Worker secret olarak sakla:

```
wrangler secret put PW_COOKIE
```

HAR dosyalarını da repoya koyma.
