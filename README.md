# HGY bot – HEGEMONY Telegram Mini App

Pixel World clan tracker (@HGYinfo_bot) for clan HEGEMONY (team 5).

- `index.html` – the Telegram Mini App (single file)
- `worker/hegemony-members-worker.js` – handler for `/api/clans/5/members?range=month|week`
- `functions/api/[[path]].js` – Pages Function serving `/api` on the same site

## Yayınlama (Cloudflare Pages)

1. Cloudflare dashboard → Workers & Pages → Create → Pages → **Connect to Git** → `hgybot` reposunu seç.
2. Build ayarları: Framework yok, build command boş, output directory `/`. Deploy.
3. Çıkan adresi (ör. `https://hgybot.pages.dev`) BotFather'da ayarla: `/mybots` → bot → Bot Settings → **Configure Mini App** (veya Menu Button) → URL.
4. Bundan sonra GitHub'a her push otomatik yayınlanır.

## API (/api)

`functions/api/[[path]].js` bir Pages Function'dır ve Pages ile birlikte otomatik yayınlanır:

- `/api/clans/5/members` → HEGEMONY haftalık/aylık puanlar. Varsayılan olarak giriş gerektirmeyen
  mrktsticker `global/clan-players` sıralamasından süzülür (`worker/hegemony-from-upstream.js`).
  `PW_AUTHORIZATION` / `PW_COOKIE` secret'ı tanımlıysa doğrudan pw.game kullanılır.
- diğer tüm `/api/...` istekleri → `https://mrktsticker.alwaysdata.net/api`

İsteğe bağlı: doğrudan pw.game kullanmak için Pages projesine secret ekle: Pages projesi → **Settings** → **Variables and Secrets** → **Add** →
tür **Secret**, ad `PW_COOKIE`, değer pw.game Cookie'si → Save. Sonra **Deployments** → son deploy → **Retry deployment**.

## Çekilişler ve ödüller (ortak depo)

`/api/giveaways` ve `/api/rewards` kendi Cloudflare D1 veritabanımızda tutulur (`worker/hgy-store.js`).
Yazma istekleri Telegram initData ile doğrulanır; çekiliş/ödül eklemek sadece adminlere açıktır.

Kurulum (bir kez):
1. Cloudflare → **Storage & Databases → D1** → **Create database** → ad: `hgy-db`.
2. hgybot Pages projesi → **Settings → Bindings → Add → D1 database** → Variable name `DB`, database `hgy-db` → Save.
3. Aynı sayfada **Variables and Secrets → Add** → Type **Secret**, Name `BOT_TOKEN`, Value: BotFather'daki bot token'ı → Save.
4. **Deployments** → son deploy → **Retry deployment**. Tablolar ilk istekte kendiliğinden oluşur.

Gizli bilgiler **asla** bu repoya yazılmaz (repo herkese açık). pw.game oturumunu Worker secret olarak sakla:

```
npx wrangler pages secret put PW_COOKIE --project-name hgybot
```

HAR dosyalarını da repoya koyma.
