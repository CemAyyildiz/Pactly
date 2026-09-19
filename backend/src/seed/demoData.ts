/**
 * The demo dataset itself (categories, sample providers, slot generation)
 * plus the upsert/seed logic both `demo.ts` (`npm run -w backend seed:demo`)
 * and `reset.ts` (`npm run demo:reset`) run against an already-open,
 * already-migrated `Db` -- pulled out of `demo.ts` so Story 3.8's reset
 * path reuses this exactly rather than re-deriving the provider list or the
 * `SEED_PROVIDER_WALLET`/`SEED_ADMIN_WALLET` checks a second time. This
 * module has no top-level side effects and never opens or closes a
 * database itself: both callers own that lifecycle (`demo.ts` opens
 * `config.databasePath` directly; `reset.ts` deletes the file first, then
 * opens the same way).
 *
 * Idempotent: categories are upserted by their unique `slug`, providers by
 * their unique `walletAddress`, and each provider's slots go through
 * `replaceFutureSlots` (Story 3.1's own replace-all-future save) -- running
 * `seedDemoData` twice in a row against the same database leaves the same
 * rows, never duplicates.
 */
import { eq } from "drizzle-orm";

import { config } from "../config.js";
import { categories, providerProfiles } from "../db/schema.js";
import { getProviderProfileByWallet, insertProviderProfile, type NewProviderProfile } from "../db/providerProfiles.js";
import { replaceFutureSlots } from "../db/availabilitySlots.js";
import { randomUUID } from "node:crypto";
import type { Db } from "../db/client.js";

export interface DemoCategory {
  id: string;
  name: string;
  slug: string;
}

export const DEMO_CATEGORIES: DemoCategory[] = [
  { id: "therapy-and-wellbeing", name: "Therapy and wellbeing", slug: "therapy-and-wellbeing" },
  { id: "education-and-lessons", name: "Education and lessons", slug: "education-and-lessons" },
  { id: "consulting", name: "Consulting", slug: "consulting" },
  { id: "fitness-and-beauty", name: "Fitness and beauty", slug: "fitness-and-beauty" },
];

export interface DemoProvider {
  /** Deterministic (not `randomUUID()`) so a printed `/providers/<id>` link
   * (Story 3.8's own `demo:reset` output) and the frontend's temporary
   * home page both resolve without a discovery/list endpoint. */
  id: string;
  walletAddress: string;
  categorySlug: string;
  displayName: string;
  title: string;
  location: string;
  sessionFormat: string;
  sessionLengthMinutes: number;
  /** USDC, integer string in the smallest unit (7 decimals, AD-7). */
  priceAmount: string;
  depositRateBps: number;
  cancellationWindowHours: number;
  /** Local hours (0-23, aligned to the 15-minute boundary rules require by
   * construction) each open day offers a slot at. */
  dailySlotHours: number[];
}

/** `amount` is a plain decimal string, e.g. "900.00" -- converted to the
 * integer smallest-unit string (7 decimals, AD-7) so every price/deposit
 * below reads naturally next to its demo intent. */
export function usdc(amount: string): string {
  const [whole, fraction = ""] = amount.split(".");
  const paddedFraction = (fraction + "0000000").slice(0, 7);
  return `${BigInt(whole + paddedFraction)}`;
}

export const DEMO_PROVIDERS: DemoProvider[] = [
  // The hero scenario (Design Notes / PRD): a client abroad locking a
  // meaningful deposit for an in-person hair-transplant consultation.
  {
    id: "demo-marmara-hair-clinic",
    walletAddress: "GDEMOHAIRCLINIC0000000000000000000000000000000001",
    categorySlug: "fitness-and-beauty",
    displayName: "Marmara Hair Clinic",
    title: "Hair transplant · FUE consult",
    location: "Koşuyolu, Istanbul",
    sessionFormat: "in_person",
    sessionLengthMinutes: 45,
    priceAmount: usdc("900.00"),
    depositRateBps: 5000,
    cancellationWindowHours: 72,
    dailySlotHours: [9, 13, 16],
  },
  {
    id: "demo-elif-aydin",
    walletAddress: "GDEMOPSYCHOLOGIST000000000000000000000000000002",
    categorySlug: "therapy-and-wellbeing",
    displayName: "Dr. Elif Aydın",
    title: "Clinical psychologist",
    location: "Osmanağa, Kadıköy, Istanbul",
    sessionFormat: "in_person",
    sessionLengthMinutes: 50,
    priceAmount: usdc("60.00"),
    depositRateBps: 3000,
    cancellationWindowHours: 24,
    dailySlotHours: [10, 14, 17],
  },
  {
    id: "demo-northside-barber",
    walletAddress: "GDEMOBARBER00000000000000000000000000000000003",
    categorySlug: "fitness-and-beauty",
    displayName: "Northside Barber",
    title: "Barber · cut and beard",
    location: "Moda, Kadıköy, Istanbul",
    sessionFormat: "in_person",
    sessionLengthMinutes: 40,
    priceAmount: usdc("20.00"),
    depositRateBps: 2500,
    cancellationWindowHours: 6,
    dailySlotHours: [11, 15, 18],
  },
  {
    id: "demo-atelier-lale",
    walletAddress: "GDEMOSALON000000000000000000000000000000000004",
    categorySlug: "fitness-and-beauty",
    displayName: "Atelier Lale",
    title: "Beauty salon · colour and cut",
    location: "Caferağa, Kadıköy, Istanbul",
    sessionFormat: "in_person",
    sessionLengthMinutes: 120,
    priceAmount: usdc("85.00"),
    depositRateBps: 2500,
    cancellationWindowHours: 24,
    dailySlotHours: [10, 14],
  },
  {
    id: "demo-kaan-demir",
    walletAddress: "GDEMOCONSULTANT10000000000000000000000000000005",
    categorySlug: "consulting",
    displayName: "Kaan Demir",
    title: "Startup strategy consulting",
    location: "Levent, Istanbul",
    sessionFormat: "video",
    sessionLengthMinutes: 60,
    priceAmount: usdc("150.00"),
    depositRateBps: 2000,
    cancellationWindowHours: 48,
    dailySlotHours: [9, 11, 15],
  },
  {
    id: "demo-mehmet-can-yilmaz",
    walletAddress: "GDEMOCOACH0000000000000000000000000000000000006",
    categorySlug: "consulting",
    displayName: "Mehmet Can Yılmaz",
    title: "Executive coaching",
    location: "Nişantaşı, Istanbul",
    sessionFormat: "video",
    sessionLengthMinutes: 60,
    priceAmount: usdc("200.00"),
    depositRateBps: 2500,
    cancellationWindowHours: 48,
    dailySlotHours: [8, 12, 16],
  },
  {
    id: "demo-zeynep-aksoy",
    walletAddress: "GDEMOTUTOR00000000000000000000000000000000007",
    categorySlug: "education-and-lessons",
    displayName: "Zeynep Aksoy",
    title: "Turkish language tutor",
    location: "Beşiktaş, Istanbul",
    sessionFormat: "video",
    sessionLengthMinutes: 45,
    priceAmount: usdc("30.00"),
    depositRateBps: 2000,
    cancellationWindowHours: 12,
    dailySlotHours: [17, 19],
  },
];

const SLOT_DAYS_AHEAD = 7;
const SECONDS_PER_DAY = 24 * 60 * 60;

/** Slots for the next `SLOT_DAYS_AHEAD` days at each of `hours` (UTC),
 * skipping any that have already passed today -- every hour lands on the
 * 15-minute boundary Story 3.1's own validation requires, and consecutive
 * hours are always at least three hours apart, comfortably clear of any
 * demo provider's `sessionLengthMinutes`. */
export function demoSlots(now: number, hours: number[]): number[] {
  const todayStart = Math.floor(now / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  const slots: number[] = [];
  for (let day = 0; day < SLOT_DAYS_AHEAD; day += 1) {
    for (const hour of hours) {
      const startsAt = todayStart + day * SECONDS_PER_DAY + hour * 60 * 60;
      if (startsAt > now) {
        slots.push(startsAt);
      }
    }
  }
  return slots;
}

async function upsertCategory(db: Db, category: DemoCategory): Promise<string> {
  const existing = await db.select().from(categories).where(eq(categories.slug, category.slug)).limit(1);
  if (existing[0]) {
    return existing[0].id;
  }
  await db.insert(categories).values(category);
  return category.id;
}

async function upsertProvider(db: Db, categoryIdBySlug: Map<string, string>, provider: DemoProvider): Promise<string> {
  const categoryId = categoryIdBySlug.get(provider.categorySlug);
  if (!categoryId) {
    throw new Error(`No seeded category for slug "${provider.categorySlug}"`);
  }
  const existing = await getProviderProfileByWallet(db, provider.walletAddress);
  const fields = {
    categoryId,
    displayName: provider.displayName,
    title: provider.title,
    location: provider.location,
    sessionFormat: provider.sessionFormat,
    sessionLengthMinutes: provider.sessionLengthMinutes,
    priceAmount: provider.priceAmount,
    depositRateBps: provider.depositRateBps,
    cancellationWindowHours: provider.cancellationWindowHours,
    isApproved: true as const,
  };
  if (existing) {
    await db.update(providerProfiles).set(fields).where(eq(providerProfiles.id, existing.id));
    return existing.id;
  }
  // `provider.id` is deterministic for the seven sample providers (see the
  // `DemoProvider.id` field's own comment) and a fresh `randomUUID()` for
  // the SEED_PROVIDER_WALLET profile, which is only ever looked up by
  // wallet, never linked to by id.
  const id = provider.id;
  const values: NewProviderProfile = { id, walletAddress: provider.walletAddress, createdAt: Date.now(), ...fields };
  await insertProviderProfile(db, values);
  return id;
}

/** Upserts the demo categories, the seven sample providers and their open
 * slots, plus (when set) the `SEED_PROVIDER_WALLET` tester profile and the
 * `SEED_ADMIN_WALLET` expectations check -- against an already-open,
 * already-migrated `db`. Never opens, migrates or closes a database itself;
 * that is each caller's own job (`demo.ts` and `reset.ts`). */
export async function seedDemoData(db: Db, logPrefix = "[seed:demo]"): Promise<void> {
  const categoryIdBySlug = new Map<string, string>();
  for (const category of DEMO_CATEGORIES) {
    categoryIdBySlug.set(category.slug, await upsertCategory(db, category));
  }

  const now = Math.floor(Date.now() / 1000);
  for (const provider of DEMO_PROVIDERS) {
    const providerProfileId = await upsertProvider(db, categoryIdBySlug, provider);
    await replaceFutureSlots(db, providerProfileId, demoSlots(now, provider.dailySlotHours), now);
  }
  console.log(`${logPrefix} upserted ${DEMO_CATEGORIES.length} categories and ${DEMO_PROVIDERS.length} providers`);

  const seedWallet = process.env.SEED_PROVIDER_WALLET?.trim();
  if (seedWallet) {
    const yourProvider: DemoProvider = {
      id: randomUUID(),
      walletAddress: seedWallet,
      categorySlug: "consulting",
      displayName: "Your Demo Practice",
      title: "Consulting · edit me in the panel",
      location: "Istanbul",
      sessionFormat: "video",
      sessionLengthMinutes: 60,
      priceAmount: usdc("100.00"),
      depositRateBps: 2000,
      cancellationWindowHours: 24,
      dailySlotHours: [10, 14, 18],
    };
    const providerProfileId = await upsertProvider(db, categoryIdBySlug, yourProvider);
    await replaceFutureSlots(db, providerProfileId, demoSlots(now, yourProvider.dailySlotHours), now);
    console.log(`${logPrefix} upserted SEED_PROVIDER_WALLET profile for ${seedWallet}`);
  } else {
    console.log(`${logPrefix} SEED_PROVIDER_WALLET not set -- skipping the tester's own profile`);
  }

  // Story 3.6: the admin role has no database row -- it is entirely
  // `config.adminWallets` (PACTLY_ADMIN_WALLETS) plus
  // `config.trustlessWorkPlatformAddress` (Pactly's own dispute-resolver
  // signer). This is purely a demo-time expectations check: it writes
  // nothing, and only tells whoever is setting up the demo whether
  // `POST /admin/bookings/:id/resolve` will actually work for the wallet
  // they intend to sign in as.
  const seedAdminWallet = process.env.SEED_ADMIN_WALLET?.trim();
  if (seedAdminWallet) {
    const isListedAdmin = config.adminWallets.includes(seedAdminWallet);
    const isDisputeResolver = seedAdminWallet === config.trustlessWorkPlatformAddress;
    if (!isListedAdmin) {
      console.log(
        `${logPrefix} SEED_ADMIN_WALLET ${seedAdminWallet} is not listed in PACTLY_ADMIN_WALLETS -- add it there ` +
          "for the admin Resolutions screen (GET /admin/disputes) to accept this wallet at all.",
      );
    }
    if (!isDisputeResolver) {
      console.log(
        `${logPrefix} SEED_ADMIN_WALLET ${seedAdminWallet} does not equal TRUSTLESS_WORK_PLATFORM_ADDRESS -- ` +
          "Story 3.6's resolve action requires the two to be the exact same wallet (Pactly's own dispute-resolver " +
          "signer), so resolving a dispute as this wallet will 403 NOT_DISPUTE_RESOLVER until they match.",
      );
    }
    if (isListedAdmin && isDisputeResolver) {
      console.log(`${logPrefix} SEED_ADMIN_WALLET ${seedAdminWallet} is configured correctly as Pactly's dispute resolver.`);
    }
  } else {
    console.log(
      `${logPrefix} SEED_ADMIN_WALLET not set -- skipping the admin-resolver expectations check ` +
        "(see .env.example / README for Story 3.6's resolve action).",
    );
  }
}
