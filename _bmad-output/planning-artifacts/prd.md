# Pactly — Product Requirements Document

**Ürün:** Randevuyla çalışan profesyoneller için emanetli (escrow) kapora altyapısı
**Etkinlik:** Rise In × Stellar Pro Hackathon 2026 — Genesis Track
**Demo senaryosu:** Online terapi seansı
**Durum:** v1.0

---

## 1. Hedefler ve Arka Plan

### Hedefler

- Randevuyla çalışan profesyonellerin no-show kaynaklı gelir kaybını emanetli kapora ile güvenceye almak
- Danışanın ön ödeme yaparken üstlendiği "param boşa gider mi" riskini ortadan kaldırmak
- Sınır ötesi küçük tutarlı kapora tahsilatını mümkün kılmak (kart reddi, havale gecikmesi, yüksek komisyon olmadan)
- Profesyonelin hiç kripto bilmeden, tahsilatı doğrudan Türk Lirası olarak almasını sağlamak
- Stellar testnet üzerinde uçtan uca çalışan bir kanıt (PoC) teslim etmek

### Arka Plan

Randevuyla çalışan her meslekte ürün zamandır. Bir terapistin 14:00 seansı, bir eğitmenin kort saati, bir danışmanın ayırdığı bir saat — müşteri gelmediğinde bu zaman geri satılamaz. Sektör bu kaybı iptal politikalarıyla karşılamaya çalışır ("24 saat önce haber vermezseniz ücret tahsil edilir"), ancak politika bir tahsilat mekanizması değildir.

Profesyonel önden ödeme isterse bu kez risk danışana geçer. Tanımadığı birine, özellikle başka bir ülkedeki birine önden ödeme yapmak güven gerektirir. Online çalışma yaygınlaştıkça taraflar farklı ülkelerde olabiliyor ve küçük tutarlı bir kaporayı tahsil etmek orantısız şekilde zorlaşıyor.

Pactly, kaporayı tarafsız bir emanette kilitler; randevu gerçekleşince profesyonele serbest bırakır, gerçekleşmezse iptal politikasına göre çözer. Ödeyen kripto ya da TL kullanabilir; profesyonel her zaman TL alır.

### Değişiklik Günlüğü

| Tarih | Sürüm | Açıklama |
|---|---|---|
| 2026-09 | v1.0 | İlk taslak |

---

## 2. Gereksinimler

### Fonksiyonel Gereksinimler

- **FR1:** Profesyonel; müsaitlik takvimi, seans ücreti, kapora oranı ve iptal politikası (deadline) tanımlayabilmeli.
- **FR2:** Danışan müsait bir saat seçip randevu talebi oluşturabilmeli; kapora tutarını ve iptal politikasını ödeme öncesinde görmeli.
- **FR3:** Sistem, kaporayı Soroban contract'ında kilitlemeli; kilitlenen tutar ne platforma ne de karşı tarafa geçmemeli.
- **FR4:** Danışan kaporayı iki yoldan ödeyebilmeli: (a) cüzdanından stablecoin ile, (b) SEP-6 deposit ile doğrudan TRY.
- **FR5:** Kapora kilitlendiğinde randevu saati kapanmalı (başka danışan aynı saati alamamalı).
- **FR6:** Seans gerçekleşip onaylandığında kilitli tutar profesyonele serbest kalmalı.
- **FR7:** Randevu gerçekleşmezse contract, iptal deadline'ına göre otomatik karar vermeli: zamanında iptalde danışana iade, geç iptal/no-show'da profesyonele aktarım.
- **FR8:** Profesyonel serbest kalan tutarı SEP-6 withdraw ile Türk Lirası olarak çekebilmeli.
- **FR9:** Her iki taraf da randevu ve kapora durumunu (kilitli / serbest / iade) tek panelden görebilmeli.
- **FR10:** Kimlik doğrulama SEP-10 ile cüzdan imzası üzerinden yapılmalı; şifre veya kayıt olmamalı.
- **FR11:** Contract her durum geçişinde event yayınlamalı (locked, released, refunded).

### Fonksiyonel Olmayan Gereksinimler

- **NFR1:** Tüm akış Stellar testnet üzerinde çalışmalı (mainnet bonus).
- **NFR2:** Anchor entegrasyonu SEP standartlarıyla yapılmalı; mainnet'e geçişte yalnızca home domain ve network passphrase değişmeli.
- **NFR3:** Kapora tutarları anchor limitleri içinde kalmalı (min 50 TRY, max 3000 TRY/işlem).
- **NFR4:** Ürün yalnızca randevu ve ödeme katmanıdır; seans içeriği, notu, video görüşmesi ve sağlık verisi kapsam dışıdır.
- **NFR5:** Contract'ta tamsayı taşması kontrolleri açık olmalı; tutarlar i128 olarak tutulmalı.
- **NFR6:** Demo ≤5 dakikada uçtan uca gösterilebilmeli.

---

## 3. Teknik Varsayımlar

### Depo Yapısı
Monorepo:
```
contracts/escrow/   → Soroban (Rust) escrow contract
backend/            → Node.js + TypeScript, SEP entegrasyonları
frontend/           → React + TypeScript + Vite
scripts/            → testnet hesap fonlama, trustline kurulumu
```

### Servis Mimarisi
Escrow mantığı zincirde (Soroban contract). Backend; SEP-10 auth, SEP-6 deposit/withdraw, SEP-38 quote akışlarını yürütür ve contract çağrılarını sarar. Frontend yalnızca sunum ve cüzdan imzalama katmanıdır.

### Anchor Konfigürasyonu (hackathonda sağlanıyor)

| Alan | Değer |
|---|---|
| Home domain | `tr-mock-anchor.fly.dev` |
| Asset | USDC |
| Network | Stellar testnet (Test SDF Network ; September 2015) |
| SEP yüzeyi | SEP-1, SEP-10, SEP-6, SEP-12, SEP-38 — **SEP-24 yok** |
| Limit / ücret | min 50 TRY · max 3000 TRY/işlem · %0.5 spread |
| Kimlik | SEP-10 cüzdan imzası (API key yok, kayıt yok) |
| Keşif | Endpoint'ler `stellar.toml`'dan okunmalı |

### Varlık Kararı: USDC vs USDT0

MVP, testnet'te çalışan **USDC + SEP-6** rayı üzerine kurulur. USDT0 mainnet'te canlıdır (LayerZero OFT) ancak hackathonun eligible integration partner listesinde değildir ve testnet kaydı bulunmamaktadır — bu nedenle **vizyon/roadmap katmanı** olarak konumlandırılır, zorunlu entegrasyon olarak değil.

### Test Gereksinimleri
Contract için birim testleri zorunlu: lock+release, zamanında iptal (iade), no-show (profesyonele aktarım). Backend için SEP akışlarının entegrasyon testi.

### Ek Teknik Notlar
- Soroban SDK'nın güncel sürümü kullanılmalı; `register_contract` gibi deprecated API'lerden kaçınılmalı.
- Cüzdanda XLM bakiyesi ve USDC trustline akışın ilk adımında otomatik kurulmalı; aksi halde anchor `pending_trust` durumunda bekler.
- Submission şartı: kullanılan skill dosyaları README'de path ile belirtilmeli.

---

## 4. Epic Listesi

- **Epic 1 — Temel Altyapı ve Escrow Contract:** Monorepo iskeleti, Soroban escrow contract'ı ve testleri, testnet kurulum scriptleri.
- **Epic 2 — Anchor Entegrasyonu ve Ödeme Rayı:** SEP-10 auth, SEP-6 deposit/withdraw, SEP-38 quote; backend servis katmanı.
- **Epic 3 — Randevu Akışı ve Arayüz:** Profesyonel profili, danışan rezervasyonu, cüzdan bağlama, ödeme ve iki taraflı panel.

---

## Epic 1 — Temel Altyapı ve Escrow Contract

**Amaç:** Projenin iskeletini kurmak ve emanet mantığını zincirde çalışır hale getirmek. Bu epic sonunda, kapora kilitleme ve çözme mantığı testlerle doğrulanmış olmalı.

### Story 1.1 — Monorepo iskeleti ve geliştirme ortamı

Bir geliştirici olarak, projeyi tek komutla kurup çalıştırabilmek istiyorum, böylece ekip hızlıca geliştirmeye başlayabilir.

**Kabul Kriterleri**
1. `contracts/`, `backend/`, `frontend/`, `scripts/` klasörleri oluşturulmuş olmalı.
2. Kök dizinde README; kurulum, derleme ve çalıştırma adımlarını içermeli.
3. Rust toolchain ve Node sürüm gereksinimleri belgelenmiş olmalı.
4. `.gitignore` her üç alt proje için uygun şekilde yapılandırılmış olmalı.

### Story 1.2 — Escrow contract veri modeli ve initialize

Bir geliştirici olarak, randevu verisini zincirde tutan bir contract iskeletine ihtiyacım var, böylece emanet mantığı bunun üzerine kurulabilir.

**Kabul Kriterleri**
1. `Booking` yapısı şu alanları içermeli: professional, client, token, amount, cancel_deadline, state.
2. `BookingState` enum'u Locked / Released / Refunded değerlerini içermeli.
3. `initialize(admin)` yalnızca bir kez çağrılabilmeli; tekrar çağrıldığında `AlreadyInitialized` hatası dönmeli.
4. Hata tipleri contracterror olarak tanımlanmış olmalı.

### Story 1.3 — Kapora kilitleme (create_booking)

Bir danışan olarak, randevu alırken kaporamın tarafsız bir yerde kilitlenmesini istiyorum, böylece param profesyonele doğrudan geçmeden güvende olsun.

**Kabul Kriterleri**
1. `create_booking(booking_id, professional, client, token, amount, cancel_deadline)` danışan yetkisi (`require_auth`) gerektirmeli.
2. Tutar, token contract'ı üzerinden danışandan alınıp contract adresine aktarılmalı.
3. `amount <= 0` ise `InvalidAmount` hatası dönmeli.
4. Aynı `booking_id` ile ikinci kez çağrıldığında `BookingExists` hatası dönmeli.
5. Kayıt persistent storage'a `Locked` durumuyla yazılmalı.
6. `locked` event'i booking_id ve tutar ile yayınlanmalı.

### Story 1.4 — Serbest bırakma (release)

Bir profesyonel olarak, seans gerçekleştiğinde kaporanın bana geçmesini istiyorum, böylece emeğimin karşılığını alabileyim.

**Kabul Kriterleri**
1. `release(booking_id)` yalnızca `Locked` durumundaki kayıtlarda çalışmalı; aksi halde `InvalidState` dönmeli.
2. Kilitli tutar contract adresinden profesyonelin adresine aktarılmalı.
3. Kayıt `Released` durumuna geçmeli.
4. `released` event'i yayınlanmalı.
5. Var olmayan booking_id için `BookingNotFound` dönmeli.

### Story 1.5 — İptal çözümü (resolve_cancel)

Bir danışan olarak, zamanında iptal ettiğimde paramı geri almak; bir profesyonel olarak, danışan gelmediğinde kaporayı almak istiyorum.

**Kabul Kriterleri**
1. `resolve_cancel(booking_id)` ledger timestamp'ini `cancel_deadline` ile karşılaştırmalı.
2. `now <= cancel_deadline` ise tutar danışana iade edilmeli ve durum `Refunded` olmalı.
3. `now > cancel_deadline` ise tutar profesyonele aktarılmalı ve durum `Released` olmalı.
4. Yalnızca `Locked` durumunda çalışmalı.
5. İlgili event (`refunded` veya `released`) yayınlanmalı.

### Story 1.6 — Contract birim testleri

Bir geliştirici olarak, emanet mantığının doğru çalıştığını testlerle görmek istiyorum, böylece demo günü sürpriz yaşamayayım.

**Kabul Kriterleri**
1. Kilitle + serbest bırak senaryosu test edilmeli; profesyonelin bakiyesi artmalı.
2. Zamanında iptal senaryosu test edilmeli; danışanın bakiyesi tam geri dönmeli.
3. No-show senaryosu test edilmeli (deadline geçmiş); tutar profesyonele gitmeli.
4. Hata durumları test edilmeli: çift booking, geçersiz tutar, yanlış durum geçişi.
5. `cargo test` ile tüm testler geçmeli.

### Story 1.7 — Testnet kurulum scriptleri

Bir geliştirici olarak, testnet hesaplarını ve trustline'ları tek komutla hazırlamak istiyorum, böylece demo öncesi kurulum zaman kaybettirmesin.

**Kabul Kriterleri**
1. Script, test hesaplarını friendbot ile fonlamalı.
2. USDC trustline'ı otomatik kurulmalı.
3. Contract testnet'e deploy edilip contract ID çıktı olarak verilmeli.
4. Script çıktısı `.env` dosyasına yazılabilir formatta olmalı.

---

## Epic 2 — Anchor Entegrasyonu ve Ödeme Rayı

**Amaç:** TL bacağını kurmak. Bu epic sonunda profesyonel, kaporayı gerçek bir SEP-6 akışıyla Türk Lirası olarak çekebilmeli.

### Story 2.1 — SEP-1 keşif ve SEP-10 kimlik doğrulama

Bir kullanıcı olarak, cüzdanımla giriş yapmak istiyorum, böylece şifre veya kayıt olmadan sisteme erişebileyim.

**Kabul Kriterleri**
1. `stellar.toml` dosyası home domain'den okunmalı; endpoint'ler oradan keşfedilmeli (sabit kodlanmamalı).
2. SEP-10 challenge alınmalı, cüzdanla imzalanmalı, JWT elde edilmeli.
3. JWT backend tarafında saklanmalı ve sonraki SEP çağrılarında kullanılmalı.
4. Geçersiz imza durumunda anlamlı hata mesajı dönmeli.

### Story 2.2 — SEP-38 kur sorgusu

Bir kullanıcı olarak, ödeme yapmadan önce güncel TRY karşılığını görmek istiyorum, böylece ne kadar ödediğimi bileyim.

**Kabul Kriterleri**
1. SEP-38 üzerinden USDC↔TRY fiyatı alınabilmeli.
2. Alınan kur, kullanıcıya ödeme ekranında gösterilmeli.
3. %0.5 spread hesaba katılmış tutar gösterilmeli.

### Story 2.3 — SEP-6 withdraw (profesyonelin TL çekmesi)

Bir profesyonel olarak, serbest kalan kaporayı Türk Lirası olarak çekmek istiyorum, böylece kripto ile uğraşmayayım.

**Kabul Kriterleri**
1. SEP-12 KYC akışı tetiklenmeli (mock anchor'da simüle, otomatik onaylı).
2. SEP-6 withdraw başlatılmalı; anchor'dan hedef adres ve memo alınmalı.
3. USDC + memo anchor'a gönderilmeli.
4. İşlem durumu (`pending_user_transfer_start` → `completed`) takip edilip kullanıcıya gösterilmeli.
5. Limit dışı tutarlarda (>3000 TRY) anlamlı hata gösterilmeli.

### Story 2.4 — SEP-6 deposit (danışanın TRY ile ödemesi)

Bir danışan olarak, kripto kullanmadan doğrudan TL ile kapora ödemek istiyorum.

**Kabul Kriterleri**
1. SEP-6 deposit başlatılmalı; anchor'dan banka bilgisi ve referans alınmalı.
2. Mock ödeme tamamlandığında cüzdana USDC geçmeli.
3. Gelen USDC ile contract'ta kapora kilitlenmeli.
4. Trustline yoksa akış kullanıcıyı önce trustline kurmaya yönlendirmeli.

### Story 2.5 — Backend servis katmanı ve veri modeli

Bir geliştirici olarak, randevu ve kullanıcı verisini tutan bir backend'e ihtiyacım var, böylece frontend tek bir API ile çalışabilsin.

**Kabul Kriterleri**
1. Profesyonel profili (müsaitlik, ücret, kapora oranı, iptal politikası) saklanmalı.
2. Randevu kaydı ve zincirdeki booking_id eşleştirilmeli.
3. Contract çağrıları (create/release/resolve) servis katmanından yapılabilmeli.
4. Contract event'leri dinlenip randevu durumu güncellenmeli.

---

## Epic 3 — Randevu Akışı ve Arayüz

**Amaç:** Uçtan uca demo edilebilir bir kullanıcı deneyimi. Bu epic sonunda terapi senaryosu baştan sona tıklanabilir olmalı.

### Story 3.1 — Profesyonel profili ve müsaitlik tanımlama

Bir profesyonel olarak, çalışma saatlerimi ve kapora kurallarımı tanımlamak istiyorum, böylece danışanlar randevu alabilsin.

**Kabul Kriterleri**
1. Seans ücreti, kapora oranı (%) ve iptal deadline'ı (saat) girilebilmeli.
2. Müsait saatler takvim üzerinde işaretlenebilmeli.
3. Profil kaydedildiğinde danışan tarafında görünür olmalı.

### Story 3.2 — Danışan rezervasyon akışı

Bir danışan olarak, uygun bir saat seçip kaporayı ödeyerek randevumu kesinleştirmek istiyorum.

**Kabul Kriterleri**
1. Müsait saatler listelenmeli; dolu saatler seçilemez olmalı.
2. Seçim sonrası kapora tutarı, toplam ücret ve iptal politikası açıkça gösterilmeli.
3. Cüzdan bağlanabilmeli (Stellar Wallets Kit).
4. Ödeme yolu seçilebilmeli: stablecoin veya TRY (SEP-6 deposit).
5. Ödeme sonrası randevu onaylanmalı ve saat kapanmalı.

### Story 3.3 — İki taraflı durum paneli

Bir kullanıcı olarak, randevumun ve kaporamın durumunu görmek istiyorum, böylece ne olduğunu takip edebileyim.

**Kabul Kriterleri**
1. Profesyonel; gelen randevuları ve kapora durumlarını listeleyebilmeli.
2. Danışan; kendi randevularını ve kapora durumunu görebilmeli.
3. Durumlar açıkça gösterilmeli: kilitli / serbest / iade edildi.
4. Zincir üzerindeki işlem bir explorer linkiyle doğrulanabilir olmalı.

### Story 3.4 — Seans onayı ve iptal akışı

Bir kullanıcı olarak, seans gerçekleştiğinde onaylamak veya gerekirse iptal etmek istiyorum.

**Kabul Kriterleri**
1. Seans sonrası danışan "gerçekleşti" onayı verebilmeli; bu `release` çağırmalı.
2. Danışan iptal edebilmeli; bu `resolve_cancel` çağırmalı.
3. İptal öncesi, deadline'a göre sonucun ne olacağı kullanıcıya gösterilmeli.
4. İşlem sonucu panele yansımalı.

### Story 3.5 — Demo hazırlığı ve dokümantasyon

Bir ekip olarak, jüriye 5 dakikada uçtan uca gösterebileceğimiz bir demo istiyoruz.

**Kabul Kriterleri**
1. README; ürün, kurulum, çalıştırma ve mimari özetini içermeli.
2. Mermaid mimari diyagramı eklenmiş olmalı.
3. Kullanılan skill dosyaları path ile belirtilmeli.
4. Demo senaryosu adım adım yazılmış olmalı (terapi seansı).
5. Testnet'te en az bir tam akış (kilitle → serbest bırak → TL çek) çalışır durumda olmalı.
