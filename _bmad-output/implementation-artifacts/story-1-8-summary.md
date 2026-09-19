# Story 1.8 — Trustless Work uyumluluğu: tek sayfa özet

**Durum:** Araştırma tamam, canlı testnet koşusu API anahtarı bekliyor. Tam bulgular: `spec-1-8-trustless-work-appointment-compatibility.md`.

## Karar: Provisional GO — yalnızca happy path için

Trustless Work'ün rol modeli Pactly'nin 7 aktörüne temiz eşleşiyor, happy path (kilit → onay → talep) iyi belgelenmiş ve denetim hiçbir çözülmemiş kritik bulgu bırakmamış. 2.6'ya başlanabilir.

## Sizin bilmeniz gereken üç şey

**1. Otomatik deadline yok — resmi kaynaktan doğrulandı.** Release ve dispute her zaman ilgili rolün açık imzasını gerektiriyor, saat tek başına hiçbir şeyi tetiklemiyor. Yani zamanında iptal, geç iptal, no-show — hiçbiri kontrat tarafından otomatik çözülmüyor. Hepsi bir **dispute** olarak açılıp çözülüyor.

**2. Pactly, Dispute Resolver rolünü üstlenmek zorunda.** Nötr bir üçüncü taraf yok (MVP'de). Önerdiğim rol dağılımında happy path gerçekten müşteri+sağlayıcı arasında kalıyor (Pactly imza atmıyor), ama her anlaşmazlık/no-show Pactly'nin kendi kararına düşüyor. Bunu **onaylamanız gerekiyor** — bu bir güven modeli kararı, teknik detay değil. Onaylarsanız pitch'te "Pactly karar vermiyor" cümlesini bu kadar mutlak kuramayız; dürüst versiyon "happy path'te kimse karar vermiyor, anlaşmazlıkta Pactly çözüyor" olur.

**3. Denetim raporu iki "Yüksek" bulguyu kısmen çözülmüş bırakmış, ve denetlenen commit'ten bu yana 114 commit geçmiş** (en sonuncusu 11 gün önce, durum-geçiş kuralı değişikliği). "Audited infrastructure" derken hangi commit'i kastettiğimizi belirtmemiz gerekiyor — genel bir "denetlendi" iddiası artık doğru olmaz.

## Sizden ne gerekiyor

**Trustless Work API anahtarı.** `dapp.trustlesswork.com`'da cüzdan bağlayıp BackOffice'te üretiliyor. Onu (ve gerçek testnet işlemlerine onayınızı) verirseniz, kalan dört kabul kriterini (init/fund/approve/release/dispute'u gerçekten çalıştırmak, imza sayısını ölçmek, indexer/rate-limit'i kontrol etmek) tamamlarım.

## Kullanmayı önerdiğim rol dağılımı

| Rol | Kim |
|---|---|
| Funder | Müşteri |
| Approver | Müşteri (seansı onaylıyor) |
| Service Provider | Sağlayıcı |
| Release Signer | Sağlayıcı (onay sonrası kendi ödemesini talep ediyor) |
| Receiver | Sağlayıcı |
| Platform | Pactly |
| Dispute Resolver | **Pactly** ← güven kararı burada |
