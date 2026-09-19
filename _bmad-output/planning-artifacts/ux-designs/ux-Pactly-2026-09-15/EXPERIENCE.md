---
name: Pactly
description: Randevulu hizmetler için emanetli kapora marketplace'i — deneyim omurgası
status: final
updated: 2026-09-16
sources:
  - "{planning_artifacts}/prd.md"
  - "./DESIGN.md"
---

# Pactly — Deneyim Omurgası

> Görsel kimlik `DESIGN.md` dosyasındadır; token'lara `{colors.you}` biçiminde atıf yapılır. Çakışmada bu iki doküman kazanır, mockup'lar değil.

## Temel

Tek yüzey: **duyarlı web uygulaması** (React + TypeScript + Vite, PRD §3). Native mobil uygulama kapsam dışıdır, vizyon maddesidir.

Bir hazır bileşen kütüphanesi kullanılmaz; bileşenler `DESIGN.md` üzerinden kurulur. Hareket için Framer Motion kullanılır.

İki kullanıcı rolü ve bir yönetim rolü vardır:

- **Danışan** — hizmeti satın alan taraf. Öncelik mobildir; akış tek elle tamamlanabilmelidir.
- **Uzman** — hizmeti veren, küratörlü kabul edilmiş taraf. Öncelik masaüstüdür; panel yoğun veri gösterir.
- **Yönetim** — başvuruları onaylayan Pactly ekibi. Sade bir liste ekranı yeterlidir.

Kimlik doğrulama cüzdan imzasıyla yapılır (SEP-10). **Cüzdan yalnızca ödeme anında istenir.** Keşif, arama, profil görüntüleme ve fiyat karşılaştırma giriş gerektirmez.

Ürün dikey bağımsızdır: dil hiçbir yerde tek bir mesleğe göre yazılmaz. "Seans" yerine "görüşme", "danışan" yerine ikinci tekil şahıs kullanılır. Terapi yalnızca demo senaryosudur.

## Bilgi Mimarisi

| Yüzey | Nereden gelinir | Amaç | Öncelik |
|---|---|---|---|
| Keşfet | Ana sayfa, logo | Kategori, arama ve filtrelerle uzman bulma | MVP |
| Arama sonuçları | Keşfet arama kutusu | Sorguya göre filtrelenmiş uzman listesi | MVP |
| Uzman profili | Sonuç kartı, paylaşılan link | Uzmanı tanıma, saat seçme, kaporayı görme | MVP |
| Rezervasyon ve ödeme | Profilde saat seçimi | Sözü kurma: saat, kapora, ödeme yolu, kilitleme | MVP |
| Kilitlendi onayı | Ödeme sonrası | Sözün mühürlenmesi, kanıt ve sonraki adımlar | MVP |
| Randevularım (danışan) | Üst menü | Tüm uzmanlardaki randevular, kapora durumları, iptal ve onay | MVP |
| Uzman paneli | Üst menü (uzman rolü) | Gelen randevular, kapora durumları, kazanç | MVP |
| Müsaitlik ve kurallar | Uzman paneli | Çalışma saatleri, ücret, kapora oranı, iptal süresi | MVP |
| TL'ye çekme | Uzman paneli | Serbest kalan kaporayı SEP-6 ile TL olarak çekme | MVP |
| Uzman ol (başvuru) | Üst menü | Başvuru formu ve başvuru durumu | MVP |
| Yönetim onay listesi | Doğrudan bağlantı | Başvuruları onaylama veya reddetme | MVP (sade) |
| Değerlendirme yazma | Tamamlanan randevu | Yalnızca serbest bırakılmış kapora sonrası | MVP sonrası |
| Uzman profili düzenleme | Uzman paneli | Tanıtım, fotoğraf, diller | MVP sonrası |

Bir danışan aynı anda birden fazla uzmandan randevu alabilir; "Randevularım" bunları tek listede, tarihe göre gösterir.

→ Kompozisyon referansı: `mockups/kesfet.html`, `mockups/rezervasyon-ve-odeme.html`. Çakışmada bu omurga kazanır.

## Ses ve Ton

Metin kısa, doğrudan ve ikinci tekil şahıstır. Teknik terim kullanıcıya gösterilmez; teknik kimlikler (işlem, sözleşme) gösterilir çünkü kanıttır.

| Böyle | Böyle değil |
|---|---|
| "Kaporan emanette." | "Ödemeniz başarıyla escrow'a aktarılmıştır." |
| "17 Eylül 14:00'e kadar vazgeçersen tamamı sana döner." | "İptal politikası: 24 saat." |
| "Bu saatten sonra iptal edersen kapora Dr. Aydın'a geçer." | "Geç iptallerde iade yapılmaz." |
| "Anlaştınız." | "İşlem başarılı! 🎉" |
| "Cüzdanında bir onay bekliyor." | "Lütfen imza talebini onaylayınız." |
| "Bu saatte müsait uzman yok. Şunları deneyebilirsin:" | "Sonuç bulunamadı." |
| "Bağlantı koptu, kaporan yerinde duruyor." | "Bir hata oluştu." |

**Kripto sözcükleri:** "Stellar", "USDC", "cüzdan", "işlem" ve "sözleşme" kullanılır, çünkü güven bunlara dayanır. "Escrow", "smart contract", "Soroban", "trustline", "SEP-6", "ledger" ve "hash" kullanıcıya gösterilmez. Karşılıkları: emanet, sözleşme, kapora hesabı, işlem kaydı.

**Kaporadan bahseden her cümlede iki bilgi birlikte bulunur:** tutar ve ücretsiz iptal süresi.

## Bileşen Davranışları

Görsel özellikler `DESIGN.md.Bileşenler` bölümündedir.

| Bileşen | Kullanıldığı yer | Davranış |
|---|---|---|
| Arama kutusu | Keşfet, üst menü | 250 ms gecikmeli otomatik tamamlama. Öneriler: hizmet, kategori, uzman adı; her önerinin yanında sonuç sayısı. Enter beklenmez. |
| Kategori sekmeleri | Keşfet | Tek seçim. Seçim URL'ye yazılır, geri tuşu çalışır. |
| Filtre rayı | Keşfet (≥1024px) | Her değişiklik sonucu anında günceller, sayfa yenilenmez. Aktif filtre sayısı mobilde butonda görünür. |
| Uzman kartı | Keşfet, arama | Kartın tamamı tıklanabilir. Saat çipine tıklamak profili o saat seçili açar. |
| Saat çipi | Kart, profil, rezervasyon | Dolu saat tıklanamaz ve odak almaz. Seçim tek tıkla değişir, onay istemez. |
| Kapora hapı | Kart, profil, rezervasyon, randevular | Bilgi taşır, tıklanmaz. Tutar ve ücretsiz iptal süresi birlikte. |
| Kalan tutar satırı | Rezervasyon, randevu detayı | "Kalan 1.400 TL · görüşme öncesi" — ödeme durumu üç değerden biri: ödenmedi, Pactly üzerinden ödendi, elden ödendi. Uzman elden ödemeyi işaretleyebilir. |
| Emanet şeridi | Rezervasyon | Sayfa boyunca görünür kalır. Mobilde alta sabitlenir ve kapora tutarını taşır. |
| Kilitleme butonu | Rezervasyon | Tek tıkla cüzdan imzası ister. Basıldıktan sonra devre dışı kalır ve "Cüzdanında bir onay bekliyor" durumuna geçer. |
| Geri sayım | Randevularım, kilitlendi onayı | Ücretsiz iptal süresine kalan zaman. 6 saatin altında `{colors.alert}` rengine döner. |
| Kanıt satırı | Kilitlendi, randevu detayı | İşlem kimliğinin kısaltılmış hali ve explorer bağlantısı. Yeni sekmede açılır. |
| Durum etiketi | Randevularım, uzman paneli | Dört durum: Kilitli · Serbest bırakıldı · İade edildi · Devredildi. Metin her zaman renge eşlik eder. |

## Durum Desenleri

| Durum | Yüzey | Davranış |
|---|---|---|
| İlk yükleme | Keşfet | Kart iskeletleri (6 adet), gerçek düzenle aynı ölçüde. |
| Sonuç yok | Arama | Boş ekran yasak. Sorgu tekrarlanır, ardından üç somut öneri: filtreyi gevşet, farklı zaman, tüm kategori. |
| Boş liste | Randevularım | "Henüz randevun yok." + Keşfet'e giden birincil aksiyon. |
| Cüzdan bekliyor | Rezervasyon | Buton devre dışı, metin "Cüzdanında bir onay bekliyor". 60 saniye sonra "Cüzdanı tekrar aç" seçeneği görünür. |
| Cüzdan reddedildi | Rezervasyon | Uyarı değil bilgi: "İmzalamadın, saat hâlâ senin için ayrılı. 10 dakika geçerli." |
| Trustline eksik | Rezervasyon | Kullanıcı bu terimi görmez. Akış otomatik olarak hazırlanır; ilerleme metni "Cüzdanın ödeme için hazırlanıyor" olur. Ek onay gerekirse tek cümleyle istenir. |
| TL ile ödeme bekleniyor | Rezervasyon | Havale bilgileri ve referans numarası gösterilir, kopyalanabilir. Durum otomatik güncellenir; kullanıcı sayfayı yenilemek zorunda kalmaz. |
| Zincir onayı bekleniyor | Kilitlenme | Mühür henüz basılmaz. "Kilitleniyor" durumu ve işlem kimliği gösterilir; onaylanınca mühür animasyonu çalışır. |
| Limit dışı tutar | Rezervasyon | Kapora 50 TL altında veya 3.000 TL üstündeyse ödeme adımından **önce** uyarılır ve alternatif ödeme yolu önerilir. |
| Saat kapıldı | Rezervasyon | Seçilen saat başkası tarafından kilitlendiyse: "Bu saat az önce doldu." + aynı günün diğer saatleri. |
| Bağlantı koptu | Her yüzey | "Bağlantı koptu, kaporan yerinde duruyor." Yeniden dene aksiyonu. |
| Süre doldu | Randevularım | Ücretsiz iptal süresi geçtiğinde kart `{colors.alert}` kenarlığa döner ve iptalin sonucu metne yazılır. |
| Onay bekliyor (uzman) | Uzman paneli | Başvuru onaylanana kadar panel salt okunur; üstte durum şeridi ve tahmini süre. |

## Etkileşim İlkeleri

**Hareket.** Framer Motion ile üç hareket vardır ve hepsi anlam taşır:

1. **Birleşme** — kapora kilitlendiğinde iki taraf rengi ortadaki emanet şeridine doğru kayar ve birleşir (300 ms).
2. **Mühür** — birleşmenin ardından dairesel mühür basılır (ölçek 1.6 → 1, yay eğrisi, 400 ms). Sadece bu anda.
3. **Geçiş** — sayfalar arası yumuşak opaklık ve 8px kayma (150 ms).

`prefers-reduced-motion` açıkken üç hareket de kapanır; mühür doğrudan son halinde görünür.

**Geri alma.** Kapora kilitlendikten sonra geri alma yoktur, kural sözleşmededir. Bu yüzden geri alınamaz tek eylemden önce özet gösterilir: kime, ne zaman, ne kadar, hangi tarihe kadar iade.

**İptal.** Her iptal, sonucu söyledikten sonra onaylanır: "Şimdi iptal edersen 600 TL'nin tamamı sana döner" ya da "Şimdi iptal edersen kapora Dr. Aydın'a geçer."

**Tek imza.** Kullanıcı bir randevu için cüzdanında yalnızca bir kez imza atar.

## Erişilebilirlik Tabanı

- Klavyeyle tam gezinme; odak sırası görsel sırayla aynı. Odak halkası `{colors.focus}` ve her zaman görünür.
- Dokunma hedefleri en az 44×44px. Saat çipleri mobilde bu ölçüye büyür.
- Durum asla yalnızca renkle anlatılmaz; her durum etiketi metin taşır.
- Geri sayım ve durum değişimleri ekran okuyucuya `aria-live="polite"` ile bildirilir.
- Rakam ve para birimleri ekran okuyucuda doğru okunacak biçimde işaretlenir.
- Dolu saatler `aria-disabled` ile işaretlenir, odak almaz.
- Sayfa dili `tr`; tarih, saat ve para biçimleri Türkçe yereldir.

## Temel Akışlar

### 1. Ayşe ilk kez kapora bırakıyor (danışan, mobil)

Ayşe 34 yaşında, daha önce hiç kripto kullanmadı. Telefonundan bir psikolog arıyor.

1. Keşfet'i açar, arama kutusuna "psikolog" yazar. Öneriler açılır, ilkini seçer.
2. Kartlarda ücretin hemen altında kapora ve iptal süresini görür: `600 TL kapora · 24 saat öncesine kadar tam iade`. Karşılaştırmayı bu satıra bakarak yapar.
3. Dr. Elif Aydın'ın kartındaki "Cum 14:00" çipine dokunur; profil o saat seçili açılır.
4. Rezervasyon ekranında üç şeridi görür: kendi seçimleri, ortada kapora, altında uzmanın taahhüdü.
5. Ödeme yolu olarak "Türk Lirası" seçer, çünkü cüzdanı yoktur. Havale bilgileri ve referans numarası gelir.
6. Ödemeyi yapar. Ekran kendiliğinden ilerler; Ayşe sayfayı yenilemez.
7. **Doruk an:** İki renk ortada birleşir, mühür basılır: "Söz verildi." Ekranda 600 TL'nin emanette olduğu, 17 Eylül 14:00'e kadar iptal ederse tamamının geri döneceği ve işlemin zincirdeki kaydı yazar.
8. "Takvime ekle" der ve çıkar. Pactly'ye hesap açmamıştır.

### 2. Cem randevusunu iptal ediyor (danışan, süre dolmadan)

1. "Randevularım"ı açar. Kartta geri sayım görünür: `Ücretsiz iptal · 2 gün 19 saat`.
2. "İptal et" der. Ekran sonucu söyler: "Şimdi iptal edersen 600 TL'nin tamamı sana döner."
3. Onaylar, cüzdanında tek bir imza atar.
4. Durum "İade edildi" olur, kartta iade işleminin kaydı görünür.

### 3. Dr. Elif kazancını TL'ye çeviriyor (uzman, masaüstü)

1. Görüşmeden sonra danışan "gerçekleşti" onayını verir, kapora serbest kalır.
2. Dr. Elif panelinde "Serbest bırakıldı" durumunu ve toplam çekilebilir tutarı görür.
3. "TL olarak çek" der. Kimlik doğrulama adımı bir kez istenir, sonraki çekimlerde tekrarlanmaz.
4. Tutar banka hesabına gönderilir; durum "Yolda" ve ardından "Hesabına geçti" olur.
5. Dr. Elif hiçbir adımda kripto terimi görmez. Panelinin dili baştan sona Türk Lirasıdır.

### 4. Bir uzman platforma başvuruyor (küratörlü kabul)

1. "Uzman ol" formunu doldurur: ad, unvan, hizmet, belge, ücret, kapora oranı, iptal süresi.
2. Başvuru durumu sayfası bekleme durumunu gösterir; panel salt okunur açılır.
3. Yönetim onaylar, profil marketplace'te görünür ve "Onaylı uzman" rozeti aktifleşir.
4. İlk görüşmesi tamamlanınca "doğrulanmış seans" sayacı 1 olur.

## Zaman ve Öncelik

İki günlük geliştirme bütçesi var. Tüm yüzeyler aynı anda bitmeyebilir; sıra şudur:

1. **Vazgeçilmez:** Keşfet listesi (arama olmadan da olur), uzman profili, rezervasyon ve ödeme, kilitlendi onayı, Randevularım, uzman paneli, TL'ye çekme.
2. **Sonra:** Arama ve otomatik tamamlama, filtre rayı, başvuru formu ve yönetim onayı (demo için uzmanlar hazır onaylı eklenebilir).
3. **Vizyon:** Değerlendirme yazma, uzman profili düzenleme, native mobil uygulama, gelişmiş filtreler.

Kapora hapı, emanet şeridi ve mühür anı hiçbir koşulda kapsamdan çıkarılmaz; ürünün farkı bunlardır.

## Açık Sorular

- **Kategoriler** PRD'deki üç alandan türetildi (terapi ve iyi oluş, eğitim ve dersler, danışmanlık) ve dördüncü olarak spor ve güzellik eklendi. Kullanıcı onayı bekliyor.
- **Duyarlı öncelik** varsayım olarak alındı: danışan akışı mobil öncelikli, uzman paneli masaüstü öncelikli.
- ~~Kalan tutarın nasıl ödendiği~~ — **karara bağlandı (2026-09-16):** kalan tutar görüşmeden önce ödenir; danışan elden ya da Pactly üzerinden ödeyebilir. Randevu, kalan tutarın ödeme durumunu taşır (PRD FR22, Story 3.7).
- **Yönetim paneli** küratörlü kabul kararından doğdu, PRD'de yok. PRD güncellemesinde eklenmeli.
