# Pro Hackathon 2026 — Tracks & Handbook (özet)

**Tarih:** 19–20 Eylül 2026 · **Yer:** Grand Pera, Beyoğlu, İstanbul
**Organizatör:** Rise In x Stellar

## Track'lar

| | Genesis Track | Scale Track |
|---|---|---|
| Kimin için | Açık başvuru, deneyimli geliştiriciler | Residency mezunları + davetli takımlar + SCF/InstAward grantee |
| Ne inşa ediyorlar | Sıfırdan, gerçek Stellar entegrasyonlu (core feature veya anchor) yeni bir ürün | Mevcut Stellar ekosistem protokolleri üzerine entegrasyon/kompozisyon |
| Giriş | Açık başvuru | Sadece davetli |
| Bar | Testnet'e deploy edilmiş çalışan prototip | Genesis ile aynı teknik bar + mimari diyagram + SCF/InstAward yol haritası |
| Son gün | Demo Day (Genesis jürisi) | Lounge Day (SDF ekibi + yatırımcı/VC) |

Pactly **Genesis Track** için hazırlanıyor (README'de sabit).

## Ajanda (özet)

**Gün 1:** 09:00 kayıt · 10:15 açılış · 10:30 briefing · 13:30 öğle · 15:00 mentorluk/takım kurma · 16:00–18:30 hackathon + mentor office hours · 19:30→ gece boyu açık hackathon.

**Gün 2 (bugün):**
- 10:00–12:00 hacking + office hours
- **12:00 — Proje teslim son tarihi**
- 12:00–13:00 öğle
- 13:00–14:30 Demo Day (Genesis jürisi)
- 14:30–15:00 Genesis kazananları kararı
- 13:00–16:00 Lounge Day (Scale/Residency)
- 16:00–16:30 Kapanış + ödüller

## Genesis & Scale ortak gereksinimler

1. **Integration** — Eligible Integration Partners listesinden (veya tüm SCF Integration List'ten) bir Stellar protokolü.
2. **Anchor / Local Payments** — bir anchor ile gerçek fiat rail: kullanıcı gerçek TRY yatırıp kullanılabilir bakiye alabilmeli (veya tersi).
3. **Core Feature** — entegrasyon üründe yük taşıyan (load-bearing) bir parça olmalı, eklenti değil.

Ölçülen metrikler: kaç takım core-feature entegrasyonu shipledi, kaç anchor entegrasyonu shipledi, gerçek traction, gerçek kullanıcı onboard.

## Eligible Integration Partners (kısaltılmış)

| Kategori | Protokol |
|---|---|
| DeFi - Yield | DeFindex |
| DeFi - Lending | Blend v2, XOXNO Network |
| DeFi - DEX/Swap | Aquarius, Soroswap, Stellar Broker |
| Cross-chain | Circle CCTP, Near Intents, Allbridge |
| Wallets | Stellar Wallets Kit, Privy, DFNS |
| On/Off-ramp | Bridge, BlindPay |

(Listeye bağlı değil — tüm SCF Integration List geçerli.)

## Ödül havuzu — toplam $15,000

| | Genesis | Scale |
|---|---|---|
| 1. | $3,000 | $3,500 |
| 2. | $2,000 | $2,500 |
| 3. | $1,500 | $1,500 |
| 4. | $1,000 | – |

## Jüri kriterleri (6 başlık)

1. **Meaningful Idea & Real-World Impact** — problem net mi, hedef kullanıcı belli mi.
2. **Technical Implementation** — Stellar Testnet'e deploy, mock/hardcode değil uçtan uca çalışan flow'lar, Soroban auth/storage doğru kullanımı, mimari dokümante. (Scale: + Mermaid mimari diyagramı.)
3. **Ecosystem Fit** — eligible protokol entegrasyonu core mu yoksa eklenti mi; **gerçek Anchor/local payment flow'u (TRY ↔ Stellar, SEP standartları) bu kategoride en yüksek ağırlığa sahip**; Stellar SDK/CLI/Skills kullanımı; dokümantasyonda ilgili Stellar Skill'lere referans.
4. **User Experience** — sezgisellik, crypto'ya yabancı biri için bile anlaşılır arayüz.
5. **Traction & Continuity** — event sırasında gerçek kullanıcı/feedback, hackathon sonrası roadmap (SCF/InstAward vb.).
6. **Presentation & Documentation** — demo + README netliği, kurulum/test talimatları, SCF/InstAward adayı olacak kalitede sunum.

## Submission gereksinimleri

- Judging portal üzerinden, deadline'dan önce.
- Takım adı + tüm üyeler + iletişim.
- Proje linkleri: GitHub repo, canlı demo, deployment URL.
- Pitch deck linki (resmi template'in kopyası, "Anyone with the link can view").
- Başvurulan track(lar)ın seçimi — **sadece seçilen track değerlendirilir.**

**MVP teslimi içermeli:**
- Public GitHub repo + iyi yapılandırılmış README
- Stellar Testnet'e deploy edilmiş smart contract(lar) (Soroban SDK ile)
- Front-end / uygulama URL'i
- Çalışan, herkese açık canlı demo
- Dokümante edilmiş contract ID'leri ve deploy edilmiş artifact'lar

**Teknik dokümantasyon (README içinde yeterli, ayrı belge şart değil):** mimari, ana bileşenler, kullanılan Stellar entegrasyonları, tasarım kararları/trade-off'lar, karşılaşılan teknik zorluklar.

**Pitch:** resmi Stellar Pro Hackathon şablonunun kopyası üzerinden (orijinali düzenlemeden).

## Stellar Skills (kullanılanı README'de path ile belirtmek gerekiyor)

- Anchors (SEP 1/6/10/12/24/31/38 entegrasyonu)
- Stellar Integration Finder
- SEPs, CAPs & Ecosystem
- DeFindex SDK / Soroswap SDK
- SCF Submission Radar / Stellar Scout
- XOXNO Lending (`skills/xoxno-lending/SKILL.md`)

## Lounge Day (sadece Scale Track)

SDF ekibi + davetli yatırımcı/founder/VC'lere pitch. Pactly Genesis'te olduğu için bu aşama kapsam dışı.

## Kaynaklar (öne çıkanlar)

- Stellar Ecosystem Resources: github.com/stellar/ecosystem-resources
- Stellar AI Skills: skills.stellar.org
- Smart Wallets: Passkey-Kit, Smart Wallet Docs
- Smart Contract Dev: developers.stellar.org getting-started / example-contracts
- Testnet fonu: lab.stellar.org/account/fund
- Explorer: stellar.expert · Lab: lab.stellar.org

---
*Bu dosya, sağlanan "Pro Hackathon 2026 Tracks & Handbook" metninin proje için özetidir; tam metin kullanıcıda mevcuttur.*
