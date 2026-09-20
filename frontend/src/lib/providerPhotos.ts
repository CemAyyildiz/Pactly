/** Demo-only venue photos for the seeded providers. Unknown ids fall back
 * to the card's own initials tile -- we never invent a photo for a real
 * profile that didn't ship one. */
const DEMO_PHOTO_IDS = new Set([
  "demo-marmara-hair-clinic",
  "demo-elif-aydin",
  "demo-northside-barber",
  "demo-atelier-lale",
  "demo-kaan-demir",
  "demo-mehmet-can-yilmaz",
  "demo-zeynep-aksoy",
]);

export function providerPhotoSrc(providerId: string): string | undefined {
  return DEMO_PHOTO_IDS.has(providerId) ? `/providers/${providerId}.jpg` : undefined;
}
