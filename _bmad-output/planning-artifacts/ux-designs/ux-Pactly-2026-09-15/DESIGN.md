---
name: Pactly
description: Randevulu hizmetler için emanetli kapora marketplace'i — "İki Taraf" görsel sistemi
status: final
updated: 2026-09-16
sources:
  - "{planning_artifacts}/prd.md"
colors:
  stone: '#DCDAD3'
  paper: '#F2F1EC'
  card: '#FFFFFF'
  ink: '#111111'
  faint: '#6B6960'
  line: '#CFCDC5'
  you: '#E8B93A'
  you-ink: '#3A2A00'
  you-soft: '#F7EAC6'
  pro: '#164E4A'
  pro-text: '#D8ECE8'
  pro-soft: '#DCEAE7'
  escrow: '#111111'
  escrow-text: '#F2F1EC'
  alert: '#B4462A'
  alert-soft: '#F5E0D9'
  focus: '#1F3BE0'
typography:
  display:
    fontFamily: "'Darker Grotesque', system-ui, sans-serif"
    fontWeight: 900
    lineHeight: '0.85'
    letterSpacing: '-0.01em'
  heading:
    fontFamily: "'Familjen Grotesk', system-ui, sans-serif"
    fontWeight: 700
    lineHeight: '1.15'
  body:
    fontFamily: "'Familjen Grotesk', system-ui, sans-serif"
    fontSize: '16px'
    fontWeight: 400
    lineHeight: '1.5'
  small:
    fontFamily: "'Familjen Grotesk', system-ui, sans-serif"
    fontSize: '14px'
    lineHeight: '1.45'
  label:
    fontFamily: "'Martian Mono', ui-monospace, monospace"
    fontSize: '12px'
    fontWeight: 500
    letterSpacing: '0.02em'
  numeric:
    fontFamily: "'Darker Grotesque', system-ui, sans-serif"
    fontWeight: 900
    note: 'font-variant-numeric: tabular-nums — para ve saat her yerde'
  scale:
    note: '12 · 14 · 16 · 18 · 24 · 32 · 48 — ara değer yok'
rounded:
  sm: '6px'
  DEFAULT: '10px'
  md: '10px'
  lg: '12px'
  xl: '14px'
  full: '9999px'
spacing:
  '1': '4px'
  '2': '8px'
  '3': '12px'
  '4': '16px'
  '5': '20px'
  '6': '24px'
  '8': '32px'
  '10': '40px'
  gutter: '24px'
  gutter-mobile: '16px'
  card-pad: '14px'
components:
  button-primary:
    background: '{colors.you}'
    color: '{colors.you-ink}'
    border: '1.5px solid {colors.you-ink}'
    radius: '{rounded.md}'
    padding: '14px 20px'
    fontSize: '16px'
    fontWeight: 600
  button-escrow:
    background: '{colors.escrow}'
    color: '{colors.escrow-text}'
    radius: '{rounded.md}'
    padding: '16px 24px'
    note: 'Yalnızca kaporayı kilitleyen tek buton'
  button-ghost:
    background: 'transparent'
    color: '{colors.ink}'
    border: '1.5px solid {colors.ink}'
    radius: '{rounded.md}'
  card-expert:
    background: '{colors.card}'
    border: '1.5px solid {colors.ink}'
    radius: '{rounded.lg}'
    padding: '{spacing.card-pad}'
  badge-verified:
    background: '{colors.pro-soft}'
    color: '#0F3D3A'
    border: '1px solid #B8D5CF'
    radius: '{rounded.full}'
    fontSize: '12px'
  chip-slot:
    background: '{colors.you}'
    color: '{colors.you-ink}'
    border: '1.5px solid {colors.you-ink}'
    radius: '{rounded.sm}'
    fontSize: '13px'
  chip-slot-taken:
    background: 'transparent'
    color: '{colors.faint}'
    border: '1.5px dashed {colors.line}'
  pill-escrow:
    background: '{colors.escrow}'
    color: '{colors.escrow-text}'
    radius: '{rounded.full}'
    fontSize: '12.5px'
    note: 'Kapora tutarı + ücretsiz iptal süresi. Hardal nokta ile başlar.'
  band-escrow:
    background: '{colors.escrow}'
    color: '{colors.escrow-text}'
    note: 'Rezervasyon ekranındaki orta şerit — emanet alanı'
  seal-locked:
    color: '{colors.escrow}'
    note: 'Kilitlenme onayında basılan dairesel mühür. Tek kullanım yeri.'
---

# Pactly — Görsel Sistem (İki Taraf)

> Kaynak: `{planning_artifacts}/prd.md`. Davranış ve akışlar `EXPERIENCE.md` dosyasında. Çakışmada bu iki doküman kazanır, mockup'lar değil.

## Marka ve Üslup

Pactly bir **söz** ürünüdür. Randevu, iki tarafın birbirine verdiği bir sözdür; kapora da o sözün karşılığıdır. Görsel sistemin tamamı bu fikirden türer ve sistemin adı budur: **İki Taraf**.

Sistemin çekirdeği bir renk kuralıdır. Ekranda üç alan vardır ve kullanıcı hangi alanda olduğunu renkten anlar:

- **Hardal** danışanın tarafıdır. Seçtiği, tıkladığı, karar verdiği her şey.
- **Petrol yeşili** uzmanın tarafıdır. Kimliği, onayı, güvencesi.
- **Siyah** emanettir. Kimseye ait değildir. Kapora, sözleşme ve zincir kayıtları burada yaşar.

Bu bir dekorasyon değil, okunabilir bir kuraldır. Bir öğenin rengi, o öğenin kime ait olduğunu söyler.

Üslup açık sözlü ve sakin özgüvenlidir. Ağır gölge, cam efekti, degrade ve dekoratif illüstrasyon kullanılmaz. Derinlik renk alanlarıyla ve 1,5px'lik net kenarlarla kurulur. Ürün ciddi bir para işini anlatır ama dili resmi değildir: "Anlaştınız." der, "İşleminiz başarıyla tamamlanmıştır." demez.

**Kaçınılan:** Genel amaçlı SaaS görünümü (mavi vurgu + yumuşak gri kart + yuvarlak köşe + hafif gölge), kripto estetiği (neon, koyu degrade, parlama), stok illüstrasyon, ikon yerine emoji.

## Renkler

| Token | Değer | Rolü |
|---|---|---|
| `{colors.stone}` | #DCDAD3 | Uygulama dışı zemin, boşluk |
| `{colors.paper}` | #F2F1EC | Sayfa zemini |
| `{colors.card}` | #FFFFFF | Kart ve panel yüzeyi |
| `{colors.ink}` | #111111 | Metin, kenarlar, emanet alanı |
| `{colors.faint}` | #6B6960 | İkincil metin |
| `{colors.line}` | #CFCDC5 | Kart içi ayraç (kenarlıklar `ink` kullanır) |
| `{colors.you}` | #E8B93A | Danışanın tarafı: seçim, birincil aksiyon, müsait saat |
| `{colors.you-ink}` | #3A2A00 | Hardal üzerindeki metin |
| `{colors.pro}` | #164E4A | Uzmanın tarafı: kimlik, onay, uzman paneli |
| `{colors.pro-soft}` | #DCEAE7 | Doğrulanmış seans rozeti zemini |
| `{colors.alert}` | #B4462A | Geri alınamaz sonuç uyarısı |
| `{colors.focus}` | #1F3BE0 | Klavye odak halkası — başka hiçbir yerde kullanılmaz |

**Hardal yalnızca danışanın eyleme geçtiği yerde kullanılır.** Dolu bir saat hardal olamaz, başarı mesajı hardal olamaz. Danışan tıklayabiliyorsa hardaldır.

**Petrol yeşili tıklanabilir değildir.** Uzmanın kim olduğunu ve neyi taahhüt ettiğini anlatır. Uzman kendi panelindeyken bu renk onun tarafının zeminidir; orada da aksiyon rengi hardal olmaya devam eder.

**Siyah hem metin hem emanet rengidir.** Bir yüzey siyaha boyandıysa orada para ya da sözleşme vardır: kapora şeridi, kapora hapı, kilitleme butonu, işlem kayıtları.

**Kiremit kırmızısı nadirdir.** Sadece geri alınamaz bir sonuç anlatılırken kullanılır: ücretsiz iptal süresinin bitişi, kaporanın uzmana devri, geçmiş randevu. Hata mesajı için kullanılmaz; hata mesajları `{colors.ink}` üzerine `{colors.alert}` kenarlıkla kurulur.

**Kontrast:** `you` üzerine `you-ink` ve `pro` üzerine `pro-text` kombinasyonları 4,5:1 eşiğini geçer. Hardal üzerine beyaz metin **hiçbir koşulda** kullanılmaz.

## Tipografi

Üç aile, üç net görev:

- **Darker Grotesque 900** (`{typography.display}`) — büyük ifadeler ve rakamlar. Sıkı, geniş ve yüksek; ürünün karakteri buradan gelir. Sadece 24px ve üzerinde kullanılır.
- **Familjen Grotesk** (`{typography.body}`) — tüm okuma metni, düğmeler, kart içeriği.
- **Martian Mono 12px** (`{typography.label}`) — etiketler, adım numaraları, zincir verisi, sözleşme ve işlem kimlikleri. Büyük harf yazılır. Makinenin konuştuğu yerdir; cümle kurmaz.

Ölçek sabittir: **12 · 14 · 16 · 18 · 24 · 32 · 48**. Ara değer üretilmez.

Para tutarları ve saatler her yerde `tabular-nums` ile dizilir; listede alt alta gelen rakamlar hizalanmalıdır. Tutarlar Türkçe biçimde yazılır: binlik ayracı nokta, kuruş ayracı virgül (`2.000,00 TL`). Kripto tutarları da aynı kurala uyar (`14,35 USDC`).

## Yerleşim ve Boşluk

Boşluk ölçeği 4px katlarıdır. Sayfa kenar boşluğu masaüstünde `{spacing.gutter}`, mobilde `{spacing.gutter-mobile}`.

Kırılma noktaları: **375 · 768 · 1024 · 1440**.

- **Keşif sayfası:** 1024px üzerinde sol filtre rayı (232px) + sonuç ızgarası (2 sütun). 1024 altında filtreler alttan açılan panele iner, sonuçlar tek sütun olur.
- **Rezervasyon sayfası:** 1024px üzerinde üç şerit (danışan · emanet · uzman). 1024 altında şeritler dikey sıralanır ve **sıra değişir**: uzman kimliği üstte, danışanın seçimleri ortada, emanet altta sabit çubuk olarak kalır. Emanet şeridi hiçbir kırılma noktasında gizlenmez.
- **Uzman paneli:** masaüstü öncelikli, tablo düzeni. Mobilde tablo kart listesine dönüşür.

## Yükseklik ve Derinlik

Gölge yoktur. Ayrım üç araçla kurulur:

1. **1,5px `{colors.ink}` kenarlık** — kartlar, girdiler, butonlar.
2. **Renk alanı** — taraf rengiyle boyanmış bölge kendi katmanıdır.
3. **Kaydırılmış tam renk blok** (`4px 4px 0`) — yalnızca üstte duran geçici katmanlarda: arama önerileri, açılan menüler, modal.

Modal arka planı `{colors.ink}` üzerine %55 opaklıktır; bulanıklaştırma yapılmaz.

## Formlar

Köşe yarıçapı iki değerde toplanır: kontroller ve kartlar `{rounded.md}`–`{rounded.lg}`, hap biçimli öğeler `{rounded.full}`. Arası kullanılmaz.

Tam yuvarlak biçim üç şeye ayrılmıştır: kategori sekmeleri, rozetler ve kapora hapı. Bunlar bilgi taşır, tıklanabilir yüzey değildir (kategori sekmeleri hariç).

Logo bu sistemin özetidir: bir hardal yarım, bir petrol yeşili yarım ve ortada onları ayıran/birleştiren siyah bir çizgi.

## Bileşenler

**Uzman kartı** (`{components.card-expert}`) — Sol sütunda 76×96px fotoğraf, sol üstünde petrol yeşili "ONAYLI" rozeti. Sağ sütunda sırasıyla: ad (`{typography.display}` 28px), unvan ve süre, rozet satırı, seans ücreti (`{typography.display}` 30px), **kapora hapı**, en erken üç müsait saat. Kapora hapı kartın vazgeçilmez parçasıdır: rakip ürünlerde iptal politikası ödeme adımına kadar gizlidir, Pactly'de listede görünür.

**Kapora hapı** (`{components.pill-escrow}`) — Siyah zemin, hardal nokta, tek satır: `600 TL kapora · 24 saat öncesine kadar tam iade`. Kaporanın geçtiği her yüzeyde aynı biçimde tekrarlanır.

**Saat çipi** (`{components.chip-slot}`) — Müsait saat hardaldır. Dolu saat `{components.chip-slot-taken}` ile kesik çizgili ve soluk olur; üzeri çizilmez, tıklanamaz.

**Emanet şeridi** (`{components.band-escrow}`) — Rezervasyon ekranının ortasındaki siyah sütun. İçinde kilit ikonu, kapora tutarı ve sözleşme kimliği bulunur. İki tarafa uzanan ince çizgiler soldan hardal, sağdan petrol yeşilidir: para iki taraftan gelip ortada durur.

**Kilitleme butonu** (`{components.button-escrow}`) — Uygulamadaki tek siyah butondur. Sadece kaporayı emanete alan eylemde kullanılır. Başka hiçbir buton siyah olamaz; aksi halde "bu buton parayı bağlar" sinyali değersizleşir.

**Mühür** (`{components.seal-locked}`) — Kilitlenme onayında basılan dairesel işaret. Çevresinde Martian Mono ile taraflar, tarih ve söz numarası döner. Yalnızca bu anda kullanılır; başka ekranda tekrarlanmaz.

**Rozetler** — "Onaylı uzman" (küratörlü kabul) ve "38 doğrulanmış seans" (kaporası serbest bırakılmış tamamlanan seans sayısı) petrol yeşili ailesindedir. Bu iki rozet uydurulamaz; ikisi de arkasında zincirde ya da yönetimde bir kayıt olduğu için vardır.

## Yapılacaklar ve Yapılmayacaklar

**Yapılacak**
- Taraf rengini kuralına göre kullan: hardal danışanın eylemi, petrol uzmanın kimliği, siyah emanet.
- Kapora tutarını ve ücretsiz iptal süresini her zaman birlikte göster.
- Para ve saat için `tabular-nums` kullan; Türkçe sayı biçimini koru.
- İkonlar için çizgi tabanlı SVG kullan (Lucide veya eşdeğeri), 1,5–2px kalınlık.
- Hareketi 150–300 ms arasında tut; `prefers-reduced-motion` ayarına uy.
- Klavye odağını her zaman `{colors.focus}` halkasıyla görünür kıl.

**Yapılmayacak**
- Siyah butonu kaporayı kilitlemek dışında kullanma.
- Hardalı bilgi ya da başarı rengi olarak kullanma; o bir aksiyon rengidir.
- Kiremit kırmızısını dekoratif amaçla kullanma.
- Gölge, cam efekti, degrade zemin ve parlama ekleme.
- İkon yerine emoji koyma.
- Beş renkten fazlasını aynı ekranda toplama; taş ve kağıt zemin renkleri bu sayıya dahil değildir.
- Ölçek dışı font boyutu üretme.
