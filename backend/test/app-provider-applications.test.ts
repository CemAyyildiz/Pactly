/**
 * Story 4.1/4.2 at the HTTP boundary: a wallet applies to list its shop,
 * reads the application back, and an admin approves or rejects it. Driven
 * through `app.request(...)` like `app-providers.test.ts`; the admin env
 * fixture supplies two real admin wallets.
 */
import "./testConfigEnvAdmin.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.js";
import { issuePactlyJwt } from "../src/auth/challenge.js";
import { NON_RESOLVER_ADMIN_WALLET } from "./testConfigEnvAdmin.js";
import { closeDatabase, openTestDatabase, seedCategory } from "./helpers.js";

const APPLICANT = "GAPPLICANTWALLETFORSTORY41TESTS";

function validApplication(categoryId: string) {
  return {
    name: "Atelier Test",
    title: "Barber · cut and beard",
    categoryId,
    location: "Kadıköy, Istanbul",
    serviceDescription: "Cut and beard in a two-chair shop, forty minutes, walk-ins welcome.",
    sessionFormat: "in_person",
    sessionLengthMinutes: 40,
    priceAmount: "20000000",
    depositRateBps: 2500,
    cancellationWindowHours: 6,
  };
}

async function bearer(walletAddress: string): Promise<{ authorization: string; "content-type": string }> {
  return { authorization: `Bearer ${await issuePactlyJwt(walletAddress)}`, "content-type": "application/json" };
}

test("applying creates a pending application and an unlisted, unapproved profile (4.1 AC2/AC4)", async () => {
  const result = openTestDatabase();
  try {
    const categoryId = await seedCategory(result, "cat-apply");
    const app = createApp(result.db);
    const headers = await bearer(APPLICANT);

    const created = await app.request("/me/provider/application", {
      method: "POST",
      headers,
      body: JSON.stringify(validApplication(categoryId)),
    });
    assert.equal(created.status, 201);
    const body = (await created.json()) as { application: { id: string; state: string; deposit: { amount: string }; profileId: string | null } };
    assert.equal(body.application.state, "pending");
    assert.equal(body.application.deposit.amount, "5000000");
    assert.ok(body.application.profileId);

    const own = await app.request("/me/provider", { headers });
    assert.equal(own.status, 200);
    assert.equal(((await own.json()) as { isApproved: boolean }).isApproved, false);

    const listed = await app.request("/providers");
    assert.equal(((await listed.json()) as { providers: unknown[] }).providers.length, 0);

    const readBack = await app.request("/me/provider/application", { headers });
    assert.equal(readBack.status, 200);
    assert.equal(((await readBack.json()) as { application: { id: string } }).application.id, body.application.id);

    const again = await app.request("/me/provider/application", {
      method: "POST",
      headers,
      body: JSON.stringify(validApplication(categoryId)),
    });
    assert.equal(again.status, 409);
    assert.equal(((await again.json()) as { code: string }).code, "APPLICATION_PENDING");
  } finally {
    closeDatabase(result);
  }
});

test("an invalid application is refused with per-field details and nothing is saved", async () => {
  const result = openTestDatabase();
  try {
    const categoryId = await seedCategory(result, "cat-invalid");
    const app = createApp(result.db);
    const headers = await bearer(APPLICANT);

    const response = await app.request("/me/provider/application", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...validApplication(categoryId), name: "A", sessionFormat: "telepathy", depositRateBps: 0 }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { code: string; details: Record<string, string> };
    assert.equal(body.code, "INVALID_APPLICATION");
    assert.ok(body.details.name);
    assert.ok(body.details.sessionFormat);
    assert.ok(body.details.depositRateBps);

    const none = await app.request("/me/provider/application", { headers });
    assert.equal(none.status, 404);
    assert.equal(((await none.json()) as { code: string }).code, "NO_APPLICATION");
    const own = await app.request("/me/provider", { headers });
    assert.equal(own.status, 404);
  } finally {
    closeDatabase(result);
  }
});

test("only an admin sees the queue; approving lists the profile immediately (4.2 AC1/AC3/AC5)", async () => {
  const result = openTestDatabase();
  try {
    const categoryId = await seedCategory(result, "cat-approve");
    const app = createApp(result.db);
    const applicant = await bearer(APPLICANT);
    const admin = await bearer(NON_RESOLVER_ADMIN_WALLET);

    const created = await app.request("/me/provider/application", { method: "POST", headers: applicant, body: JSON.stringify(validApplication(categoryId)) });
    const { application } = (await created.json()) as { application: { id: string } };

    const asApplicant = await app.request("/admin/applications", { headers: applicant });
    assert.equal(asApplicant.status, 404);
    assert.equal(((await asApplicant.json()) as { code: string }).code, "NOT_ADMIN");

    const queue = await app.request("/admin/applications", { headers: admin });
    assert.equal(queue.status, 200);
    const queued = (await queue.json()) as { applications: Array<{ id: string; walletAddress: string }> };
    assert.deepEqual(queued.applications.map((a) => a.id), [application.id]);
    assert.equal(queued.applications[0]!.walletAddress, APPLICANT);

    const approved = await app.request(`/admin/applications/${application.id}/decide`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ outcome: "approve" }),
    });
    assert.equal(approved.status, 200);
    assert.equal(((await approved.json()) as { application: { state: string } }).application.state, "approved");

    const listed = await app.request("/providers");
    const providers = ((await listed.json()) as { providers: Array<{ displayName: string }> }).providers;
    assert.equal(providers.length, 1);
    assert.equal(providers[0]!.displayName, "Atelier Test");

    const own = await app.request("/me/provider", { headers: applicant });
    assert.equal(((await own.json()) as { isApproved: boolean }).isApproved, true);

    const twice = await app.request(`/admin/applications/${application.id}/decide`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ outcome: "approve" }),
    });
    assert.equal(twice.status, 409);

    const reapply = await app.request("/me/provider/application", { method: "POST", headers: applicant, body: JSON.stringify(validApplication(categoryId)) });
    assert.equal(reapply.status, 409);
    assert.equal(((await reapply.json()) as { code: string }).code, "ALREADY_A_PROVIDER");
  } finally {
    closeDatabase(result);
  }
});

test("rejecting needs a reason, tells the applicant why, and lets them apply again (4.2 AC2/AC4)", async () => {
  const result = openTestDatabase();
  try {
    const categoryId = await seedCategory(result, "cat-reject");
    const app = createApp(result.db);
    const applicant = await bearer(APPLICANT);
    const admin = await bearer(NON_RESOLVER_ADMIN_WALLET);

    const created = await app.request("/me/provider/application", { method: "POST", headers: applicant, body: JSON.stringify(validApplication(categoryId)) });
    const { application } = (await created.json()) as { application: { id: string } };

    const noReason = await app.request(`/admin/applications/${application.id}/decide`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ outcome: "reject" }),
    });
    assert.equal(noReason.status, 400);

    const rejected = await app.request(`/admin/applications/${application.id}/decide`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ outcome: "reject", reason: "Please add a real shop address." }),
    });
    assert.equal(rejected.status, 200);

    const own = await app.request("/me/provider/application", { headers: applicant });
    const ownBody = (await own.json()) as { application: { state: string; rejectionReason: string | null } };
    assert.equal(ownBody.application.state, "rejected");
    assert.equal(ownBody.application.rejectionReason, "Please add a real shop address.");

    const stillUnlisted = await app.request("/providers");
    assert.equal(((await stillUnlisted.json()) as { providers: unknown[] }).providers.length, 0);

    const reapply = await app.request("/me/provider/application", {
      method: "POST",
      headers: applicant,
      body: JSON.stringify({ ...validApplication(categoryId), title: "Barber · Moda shop" }),
    });
    assert.equal(reapply.status, 201);
    const reapplied = (await reapply.json()) as { application: { id: string; state: string } };
    assert.notEqual(reapplied.application.id, application.id);
    assert.equal(reapplied.application.state, "pending");

    const profile = await app.request("/me/provider", { headers: applicant });
    const profileBody = (await profile.json()) as { title: string; isApproved: boolean };
    assert.equal(profileBody.title, "Barber · Moda shop");
    assert.equal(profileBody.isApproved, false);

    const queue = await app.request("/admin/applications", { headers: admin });
    assert.equal(((await queue.json()) as { applications: unknown[] }).applications.length, 1);
  } finally {
    closeDatabase(result);
  }
});
