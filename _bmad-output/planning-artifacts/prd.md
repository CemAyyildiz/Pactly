---
title: Pactly — Product Requirements Document
status: final
created: 2026-09-15
updated: 2026-09-16
---

# Pactly — Product Requirements Document

**Ürün:** Randevulu hizmetler için güvenceli randevu marketplace'i — kapora emanette tutulur
**Etkinlik:** Rise In × Stellar Pro Hackathon 2026 — Genesis Track
**Demo senaryosu:** Online terapi seansı
**Durum:** v1.1

---

## 1. Hedefler ve Arka Plan

### Hedefler

- Randevuyla çalışan tüm hizmetleri tek bir platformda listelemek ve danışanın buradan uzman bulmasını sağlamak
- Randevuyla çalışan profesyonellerin no-show kaynaklı gelir kaybını emanetli kapora ile güvenceye almak
- Danışanın ön ödeme yaparken üstlendiği "param boşa gider mi" riskini ortadan kaldırmak
- Sınır ötesi küçük tutarlı kapora tahsilatını mümkün kılmak (kart reddi, havale gecikmesi, yüksek komisyon olmadan)
- Profesyonelin hiç kripto bilmeden, tahsilatı doğrudan Türk Lirası olarak almasını sağlamak
- Stellar testnet üzerinde uçtan uca çalışan bir kanıt (PoC) teslim etmek

### Arka Plan

Randevuyla çalışan her meslekte ürün zamandır. Bir terapistin 14:00 seansı, bir eğitmenin kort saati, bir danışmanın ayırdığı bir saat — müşteri gelmediğinde bu zaman geri satılamaz. Sektör bu kaybı iptal politikalarıyla karşılamaya çalışır ("24 saat önce haber vermezseniz ücret tahsil edilir"), ancak politika bir tahsilat mekanizması değildir.

Profesyonel önden ödeme isterse bu kez risk danışana geçer. Tanımadığı birine, özellikle başka bir ülkedeki birine önden ödeme yapmak güven gerektirir. Online çalışma yaygınlaştıkça taraflar farklı ülkelerde olabiliyor ve küçük tutarlı bir kaporayı tahsil etmek orantısız şekilde zorlaşıyor.

Pactly, kaporayı tarafsız bir emanette kilitler; randevu gerçekleşince profesyonele serbest bırakır, gerçekleşmezse iptal politikasına göre çözer. Ödeyen kripto ya da TL kullanabilir; profesyonel her zaman TL alır.

Ürün bunu tek bir profesyonel için değil, tüm randevulu hizmetlerin listelendiği bir marketplace olarak yapar. Danışan platformda uzman arar, karşılaştırır ve randevu alır; bir danışan farklı uzmanlardan aldığı randevuları tek panelden takip eder. Platformda yalnızca başvurusu onaylanmış uzmanlar listelenir; kalite sinyali de uydurulamaz iki veriye dayanır: onaylı uzman rozeti ve kaporası serbest bırakılmış, yani gerçekten gerçekleşmiş seans sayısı.

### Değişiklik Günlüğü

| Tarih | Sürüm | Açıklama |
|---|---|---|
| 2026-09-15 | v1.0 | İlk taslak |
| 2026-09-16 | v1.1 | Marketplace kararı: keşif, arama ve filtreler; küratörlü uzman kabulü ve yönetim onayı; doğrulanmış seansa dayalı değerlendirme; cüzdan yalnızca ödeme anında; kalan tutarın görüşme öncesi ödenmesi. Kaynak: UX turu (`ux-designs/ux-Pactly-2026-09-15/`) |

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

**Marketplace (v1.1)**

- **FR12:** Danışan, onaylı uzmanları kategori bazlı bir keşif sayfasında listeleyebilmeli; kartta ücret, kapora tutarı, ücretsiz iptal süresi ve en erken müsait saatler görünmeli.
- **FR13:** Danışan uzman, hizmet ya da kategori adıyla arama yapabilmeli; arama otomatik tamamlama önermeli ve sonuçsuz sorguda alternatif öneriler göstermeli.
- **FR14:** Sonuçlar görüşme biçimi, ücret aralığı, kapora oranı ve müsaitlik ile filtrelenebilmeli.
- **FR15:** Keşif, arama, profil görüntüleme ve fiyat karşılaştırma giriş gerektirmemeli; cüzdan yalnızca kapora ödenirken istenmeli.
- **FR16:** Her uzmanın paylaşılabilir bir profil adresi olmalı; keşiften gelen danışan ile linkle gelen danışan aynı sayfaya ulaşmalı.
- **FR17:** Bir danışan farklı uzmanlardan aldığı tüm randevuları ve kapora durumlarını tek panelden görebilmeli.
- **FR18:** Profesyonel platforma başvuru yapabilmeli; başvuru yönetim tarafından onaylanana kadar profili marketplace'te listelenmemeli.
- **FR19:** Yönetim, bekleyen başvuruları listeleyip onaylayabilmeli veya reddedebilmeli; karar başvurana bildirilmeli.
- **FR20:** Uzman profilinde "doğrulanmış seans" sayısı gösterilmeli; bu sayı yalnızca kaporası serbest bırakılmış randevulardan artmalı.
- **FR21:** Değerlendirme yalnızca kaporası serbest bırakılmış bir randevunun danışanı tarafından yazılabilmeli.
- **FR22:** Seans ücretinin kapora dışında kalan kısmı görüşmeden önce ödenmeli; danışan bunu platform dışında (elden) ya da Pactly üzerinden ödeyebilmeli. Randevu, kalan tutarın ödenip ödenmediğini durum olarak taşımalı.

### Fonksiyonel Olmayan Gereksinimler

- **NFR1:** Tüm akış Stellar testnet üzerinde çalışmalı (mainnet bonus).
- **NFR2:** Anchor entegrasyonu SEP standartlarıyla yapılmalı; mainnet'e geçişte yalnızca home domain ve network passphrase değişmeli.
- **NFR3:** Kapora tutarları anchor limitleri içinde kalmalı (min 50 TRY, max 3000 TRY/işlem).
- **NFR4:** Ürün yalnızca randevu ve ödeme katmanıdır; seans içeriği, notu, video görüşmesi ve sağlık verisi kapsam dışıdır.
- **NFR5:** Contract'ta tamsayı taşması kontrolleri açık olmalı; tutarlar i128 olarak tutulmalı.
- **NFR6:** Demo ≤5 dakikada uçtan uca gösterilebilmeli.
- **NFR7:** Ürün dikey bağımsız olmalı; arayüz dili tek bir mesleğe göre yazılmamalı. Terapi yalnızca demo senaryosudur.
- **NFR8:** Arayüz, `ux-designs/ux-Pactly-2026-09-15/DESIGN.md` ve `EXPERIENCE.md` dokümanlarına uymalı. Çakışmada bu dokümanlar mockup'lara üstün gelir.
- **NFR9:** Kullanıcıya teknik terim gösterilmemeli (escrow, Soroban, trustline, SEP-6, hash). Güven kanıtı olarak "Stellar", "cüzdan", "işlem" ve "sözleşme" gösterilebilir.
- **NFR10:** Arayüz duyarlı olmalı: danışan akışı mobil öncelikli (375px'ten itibaren), uzman paneli masaüstü öncelikli. Kırılma noktaları 375 · 768 · 1024 · 1440.

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

### Veri Modeli Eklemeleri (v1.1)

Marketplace kararı backend'e dört yeni kavram getirir:

| Kavram | İçerik |
|---|---|
| Kategori | Ad, slug, üst kategori. Başlangıç seti: terapi ve iyi oluş, eğitim ve dersler, danışmanlık, spor ve güzellik |
| Uzman başvurusu | Başvuru bilgileri, durum (bekliyor / onaylı / reddedildi), karar tarihi ve karar veren |
| Uzman profili | Kategori, tanıtım, dil, görüşme biçimi, ücret, kapora oranı, iptal süresi, doğrulanmış seans sayacı |
| Değerlendirme | Randevuya bağlı puan ve yorum; yalnızca `Released` durumundaki randevu için oluşturulabilir |

Doğrulanmış seans sayacı contract'ın `released` event'i dinlenerek artırılır; elle güncellenemez.

### UX Kaynakları

Arayüz kararları UX turunda alındı ve şu dokümanlarda tanımlıdır:

- `ux-designs/ux-Pactly-2026-09-15/DESIGN.md` — görsel sistem, renk kuralı, tipografi, bileşenler
- `ux-designs/ux-Pactly-2026-09-15/EXPERIENCE.md` — bilgi mimarisi, durumlar, metin kuralları, akışlar
- `ux-designs/ux-Pactly-2026-09-15/mockups/` — keşif ve rezervasyon ekranı referansları

---

## 4. Epic Listesi

- **Epic 1 — Temel Altyapı ve Escrow Contract:** Monorepo iskeleti, Soroban escrow contract'ı ve testleri, testnet kurulum scriptleri.
- **Epic 2 — Anchor Entegrasyonu ve Ödeme Rayı:** SEP-10 auth, SEP-6 deposit/withdraw, SEP-38 quote; backend servis katmanı.
- **Epic 3 — Marketplace ve Randevu Akışı:** Uzman profili, keşif sayfası, arama ve filtreler, danışan rezervasyonu, ödeme ve iki taraflı panel.
- **Epic 4 — Uzman Kabulü ve Güven:** Uzman başvurusu, yönetim onayı, doğrulanmış seans sayacı ve değerlendirmeler.

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
1a. `release` danışanın yetkisini (`require_auth`) istemeli; başka bir hesabın çağrısı reddedilmeli (AD-2).
1b. `resolve_cancel` izin gerektirmemeli; sonucu yalnızca ledger timestamp ile `cancel_deadline` karşılaştırması belirlemeli (AD-2).
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
4. Trustline yoksa akış otomatik kurmalı; kullanıcıya teknik terim gösterilmemeli (AD-11).
5. Danışanın cüzdanı yoksa backend onun adına yönetilen bir Stellar hesabı açmalı; deposit oraya düşmeli ve kapora oradan kilitlenmeli (AD-6).
6. Yönetilen hesaptan kilitlenen bir kapora iade edildiğinde backend, `refunded` event'i üzerine kullanıcı için SEP-6 withdraw akışını başlatmalı; para yönetilen hesapta sahipsiz kalmamalı (AD-14).
7. Yönetilen hesabın anahtarı yalnızca iki iş için kullanılmalı: kaporayı kilitlemek ve iadeyi TL olarak çıkarmak.

### Story 2.5 — Backend servis katmanı ve veri modeli

Bir geliştirici olarak, randevu ve kullanıcı verisini tutan bir backend'e ihtiyacım var, böylece frontend tek bir API ile çalışabilsin.

**Kabul Kriterleri**
1. Profesyonel profili (müsaitlik, ücret, kapora oranı, iptal politikası) saklanmalı.
1a. Marketplace kavramları saklanmalı: kategori, uzman başvurusu ve durumu, doğrulanmış seans sayacı, değerlendirme (bkz. §3 Veri Modeli Eklemeleri).
2. Randevu kaydı ve zincirdeki booking_id eşleştirilmeli.
3. Contract çağrıları (create/release/resolve) servis katmanından yapılabilmeli.
4. Contract event'leri dinlenip randevu durumu güncellenmeli.

---

## Epic 3 — Marketplace ve Randevu Akışı

**Amaç:** Uçtan uca demo edilebilir bir kullanıcı deneyimi. Bu epic sonunda danışan, marketplace'ten uzman bulup terapi senaryosunu baştan sona tamamlayabilmeli.

### Story 3.1 — Uzman profili ve müsaitlik tanımlama

Bir profesyonel olarak, çalışma saatlerimi ve kapora kurallarımı tanımlamak istiyorum, böylece danışanlar randevu alabilsin.

**Kabul Kriterleri**
1. Seans ücreti, kapora oranı (%) ve iptal deadline'ı (saat) girilebilmeli.
2. Müsait saatler takvim üzerinde işaretlenebilmeli.
3. Profil kaydedildiğinde danışan tarafında görünür olmalı.

### Story 3.2 — Keşif sayfası ve kategoriler

Bir danışan olarak, platformdaki uzmanları kategorilere göre listelemek istiyorum, böylece ihtiyacıma uygun kişiyi bulabileyim.

**Kabul Kriterleri**
1. Yalnızca onaylı uzmanlar listelenmeli.
2. Kategori sekmeleri çalışmalı; seçim adres satırına yazılmalı ve geri tuşu doğru çalışmalı.
3. Uzman kartı şunları göstermeli: ad, unvan, görüşme biçimi ve süresi, onaylı rozeti, doğrulanmış seans sayısı, seans ücreti, kapora tutarı, ücretsiz iptal süresi ve en erken üç müsait saat.
4. Kartta bir saate tıklanınca uzman profili o saat seçili olarak açılmalı.
5. İlk yüklemede kart iskeletleri gösterilmeli.
6. Sayfa giriş yapılmadan görüntülenebilmeli.

### Story 3.3 — Arama ve filtreler

Bir danışan olarak, aradığım hizmeti yazarak ve sonuçları daraltarak bulmak istiyorum.

**Kabul Kriterleri**
1. Arama kutusu uzman adı, hizmet ve kategori üzerinde çalışmalı.
2. Otomatik tamamlama 250 ms gecikmeyle önerileri göstermeli; her önerinin yanında sonuç sayısı olmalı.
3. Filtreler uygulanabilmeli: görüşme biçimi, ücret aralığı, kapora oranı, müsaitlik.
4. Filtre değişikliği sonucu sayfa yenilenmeden güncellemeli.
5. Sonuç bulunamadığında boş ekran gösterilmemeli; sorgu tekrar edilip en az üç alternatif öneri sunulmalı.

### Story 3.4 — Danışan rezervasyon akışı

Bir danışan olarak, uygun bir saat seçip kaporayı ödeyerek randevumu kesinleştirmek istiyorum.

**Kabul Kriterleri**
1. Müsait saatler listelenmeli; dolu saatler seçilemez olmalı ve odak almamalı.
2. Seçim sonrası kapora tutarı, toplam ücret ve iptal politikası açıkça gösterilmeli; kapora tutarı ile ücretsiz iptal süresi her zaman birlikte görünmeli.
3. Cüzdan yalnızca ödeme adımında istenmeli (Stellar Wallets Kit); önceki adımlarda giriş sorulmamalı.
4. Ödeme yolu seçilebilmeli: stablecoin veya TRY (SEP-6 deposit).
5. Ödeme sonrası randevu onaylanmalı ve saat kapanmalı.
6. Kapora tutarı anchor limitleri dışındaysa (50 TRY altı, 3.000 TRY üstü) kullanıcı ödeme adımından önce uyarılmalı.
7. Seçilen saat bu sırada başkası tarafından alınırsa anlaşılır bir mesaj ve aynı günün diğer saatleri gösterilmeli.
8. Ödemeye geçişte backend bir tutma kaydı açmalı: `booking_id` üretmeli, saati 10 dakika bloke etmeli ve randevuyu `pending_lock` durumunda yazmalı (AD-13).
9. Zincire yalnızca backend'in ürettiği `booking_id` ile gidilmeli.
10. Tutma süresi imzasız dolarsa kayıt düşmeli ve saat yeniden satışa açılmalı; kullanıcıya süre bilgisi gösterilmeli.

### Story 3.5 — İki taraflı durum paneli

Bir kullanıcı olarak, randevumun ve kaporamın durumunu görmek istiyorum, böylece ne olduğunu takip edebileyim.

**Kabul Kriterleri**
1. Profesyonel; gelen randevuları ve kapora durumlarını listeleyebilmeli.
2. Danışan; farklı uzmanlardan aldığı tüm randevuları tek listede, tarihe göre görebilmeli.
3. Durumlar açıkça gösterilmeli: kilitli / serbest bırakıldı / iade edildi / devredildi. Durum yalnızca renkle değil metinle de anlatılmalı.
4. Zincir üzerindeki işlem bir explorer linkiyle doğrulanabilir olmalı.
5. Ücretsiz iptal süresine kalan zaman geri sayım olarak gösterilmeli.

### Story 3.6 — Seans onayı ve iptal akışı

Bir kullanıcı olarak, seans gerçekleştiğinde onaylamak veya gerekirse iptal etmek istiyorum.

**Kabul Kriterleri**
1. Seans sonrası danışan "gerçekleşti" onayı verebilmeli; bu `release` çağırmalı.
2. Danışan iptal edebilmeli; bu `resolve_cancel` çağırmalı.
3. İptal öncesi, deadline'a göre sonucun ne olacağı kullanıcıya gösterilmeli.
4. İşlem sonucu panele yansımalı.

### Story 3.7 — Kalan tutarın görüşme öncesi ödenmesi

Bir danışan olarak, seans ücretinin kapora dışında kalan kısmını görüşmeden önce ödemek istiyorum; bir profesyonel olarak bunun ödendiğini görmek istiyorum.

**Kabul Kriterleri**
1. Randevu kaydı kalan tutarı ve ödeme durumunu (ödenmedi / platform üzerinden ödendi / elden ödendi) taşımalı.
2. Danışan kalan tutarı Pactly üzerinden ödeyebilmeli.
3. Profesyonel, elden ödeme aldığında bunu işaretleyebilmeli.
4. İki tarafın panelinde de kalan tutarın durumu görünmeli.
5. Arayüz kalan tutarın görüşmeden önce ödendiğini açıkça belirtmeli.

### Story 3.8 — Demo hazırlığı ve dokümantasyon

Bir ekip olarak, jüriye 5 dakikada uçtan uca gösterebileceğimiz bir demo istiyoruz.

**Kabul Kriterleri**
1. README; ürün, kurulum, çalıştırma ve mimari özetini içermeli.
2. Mermaid mimari diyagramı eklenmiş olmalı.
3. Kullanılan skill dosyaları path ile belirtilmeli.
4. Demo senaryosu adım adım yazılmış olmalı (terapi seansı).
5. Testnet'te en az bir tam akış (kilitle → serbest bırak → TL çek) çalışır durumda olmalı.
6. Marketplace demo için en az 6 onaylı örnek uzman, en az iki kategoride yüklenmiş olmalı.

---

## Epic 4 — Uzman Kabulü ve Güven

**Amaç:** Marketplace'in kalite katmanını kurmak. Bu epic sonunda platformda yalnızca onaylı uzmanlar listelenmeli ve güven sinyalleri uydurulamaz verilere dayanmalı.

**Öncelik notu:** Story 4.1–4.3 MVP kapsamındadır. Story 4.4 zaman kalırsa yapılır; demo bu story olmadan da eksiksiz çalışır.

### Story 4.1 — Uzman başvuru akışı

Bir profesyonel olarak, platforma başvurmak istiyorum, böylece hizmetimi burada satabileyim.

**Kabul Kriterleri**
1. Başvuru formu şunları toplamalı: ad, unvan, kategori, hizmet tanımı, görüşme biçimi ve süresi, seans ücreti, kapora oranı, iptal süresi.
2. Başvuru kaydedildiğinde durumu `bekliyor` olmalı.
3. Başvuran, başvuru durumunu görebileceği bir sayfaya yönlendirilmeli.
4. Onaylanmamış profil marketplace listelerinde ve aramada görünmemeli.
5. Onay beklerken uzman paneli salt okunur açılmalı ve durumu belirten bir şerit göstermeli.

### Story 4.2 — Yönetim onay listesi

Bir yönetici olarak, bekleyen başvuruları inceleyip karara bağlamak istiyorum.

**Kabul Kriterleri**
1. Bekleyen başvurular liste halinde görüntülenebilmeli.
2. Başvuru onaylanabilmeli veya gerekçeyle reddedilebilmeli.
3. Onaylanan profil marketplace'te anında görünür olmalı ve "onaylı uzman" rozeti aktifleşmeli.
4. Karar başvurana bildirilmeli.
5. Ekrana yalnızca yetkili hesap erişebilmeli.

### Story 4.3 — Doğrulanmış seans sayacı

Bir danışan olarak, uzmanın gerçekten kaç görüşme yaptığını görmek istiyorum, böylece uydurma referanslara güvenmek zorunda kalmayayım.

**Kabul Kriterleri**
1. Sayaç yalnızca contract'ın `released` event'i ile artmalı.
2. Sayaç elle güncellenememeli.
3. Sayı uzman kartında ve profilinde "doğrulanmış seans" olarak gösterilmeli.
4. İptal edilen ya da iade edilen randevular sayacı artırmamalı.

### Story 4.4 — Değerlendirmeler

Bir danışan olarak, görüştüğüm uzmanı değerlendirmek istiyorum.

**Kabul Kriterleri**
1. Değerlendirme yalnızca kaporası serbest bırakılmış bir randevunun danışanı tarafından yazılabilmeli.
2. Bir randevu için yalnızca bir değerlendirme yazılabilmeli.
3. Puan ve yorum uzman profilinde gösterilmeli.
4. Değerlendirmenin hangi randevuya bağlı olduğu doğrulanabilir olmalı.
