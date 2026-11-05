/**
 * Roqqu payment links: runs the real routes against a fake Supabase and a fake
 * Roqqu. No request leaves the process, so this proves PAL follows the docs,
 * not that Roqqu's live API behaves the same way.
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import {
    configureSupabaseAuthEnv, cookieJar, installFakeSupabase, runRoute, supabaseJson, fakeSession, FAKE_USER,
} from "./helpers/routeHarness/index.mjs";

configureSupabaseAuthEnv();
process.env.PAL_DB_PROVIDER = "supabase";
process.env.PAL_SITE_URL = "https://pal.test.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service_role_offline_test_only";
const TEST_KEY = "t".repeat(40);
process.env.ROQQU_TEST_API_KEY = TEST_KEY;

const links = await import("../app/api/invoices/payment-links/route.ts");
const webhook = await import("../app/api/webhooks/roqqu/route.ts");
const callback = (await import("../app/api/auth/callback/route.ts")).GET;
const roqqu = await import("../lib/payments/roqqu.ts");

const WS = "ws-0000-aaaa";
const IV = "00112233445566778899aabbccddeeff";
const VALID = { invoice_id: "inv-1", email: "client@example.com", first_name: "Ada", last_name: "Obi", amount_ngn: "50000" };
const STORED = { id: "link-1", invoice_id: "inv-1", refid: "REF1", status: "pending", amount_required: "50000", amount_currency: "ngn", created_by: FAKE_USER.id };

let handlers, requests;
beforeEach(() => {
    handlers = {};
    requests = installFakeSupabase(new Proxy({}, { get: (_, k) => handlers[k] }));
});

async function signedIn() {
    const store = cookieJar();
    handlers["POST /auth/v1/verify"] = () => supabaseJson(200, fakeSession());
    await runRoute(callback, `/api/auth/callback?next=/reset-password&token_hash=${"a".repeat(56)}&type=recovery`, { store });
    handlers["GET /auth/v1/user"] = () => supabaseJson(200, FAKE_USER);
    handlers["GET /rest/v1/profiles"] = () => supabaseJson(200, [{ full_name: "Ada Owner", default_workspace_id: WS }]);
    handlers["GET /rest/v1/workspace_members"] = () => supabaseJson(200, [{ workspace_id: WS, role: "owner", status: "active" }]);
    requests.length = 0;
    return store;
}

function encrypt(event, key = TEST_KEY) {
    const cipher = createCipheriv("aes-256-ctr", Buffer.from(key.slice(0, 32), "utf8"), Buffer.from(IV, "hex"));
    return Buffer.concat([cipher.update(JSON.stringify(event)), cipher.final()]).toString("hex");
}

function paymentEvent(overrides = {}, type = "payment_link_completed") {
    return {
        event_id: "e1",
        event_type: type,
        meta_data: {
            payment_link_refid: "REF1", payment_reference: "PALabc", amount_required: 50000, amount_currency: "ngn",
            status: "completed", hash: "0xabc", metadata: JSON.stringify({ workspace_id: WS, invoice_id: "inv-1" }), ...overrides,
        },
    };
}

async function deliver(hash, iv = IV) {
    const res = await webhook.POST(new Request("https://pal.test.invalid/api/webhooks/roqqu", {
        method: "POST", headers: { "Content-Type": "application/json", "x-api-key": iv }, body: JSON.stringify({ hash }),
    }));
    return res.status;
}

describe("creating a payment link", () => {
    test("sends only the test header, in form encoding, with the founder's naira amount", async () => {
        let sent;
        const link = await roqqu.createRoqquPaymentLink({
            apiKey: TEST_KEY,
            input: { invoiceId: "inv-1", email: "c@example.com", firstName: "Ada", lastName: "Obi", amountNgn: "50000" },
            reference: "PALabc",
            workspaceId: WS,
            siteUrl: "https://pal.test.invalid",
            fetchImpl: async (url, init) => {
                sent = { url, init };
                return new Response(JSON.stringify({ data: { refid: "REF1", payment_link: "https://payment.roqqu.com/REF1", amount_required: 50000, amount_currency: "ngn" } }));
            },
        });
        assert.equal(sent.url, "https://service.roqqu.com/v1/payment-links");
        assert.equal(sent.init.headers["x-staging-api-key"], TEST_KEY);
        assert.equal(sent.init.headers["x-api-key"], undefined);
        const form = new URLSearchParams(sent.init.body);
        assert.equal(form.get("amount"), "50000");
        assert.equal(form.get("amount_currency"), "ngn");
        assert.deepEqual(JSON.parse(form.get("metadata")), { workspace_id: WS, invoice_id: "inv-1" });
        assert.equal(link.paymentLink, "https://payment.roqqu.com/REF1");
    });

    test("references meet Roqqu's 1-20 alphanumeric rule", () => {
        assert.match(roqqu.newPaymentReference(), /^[A-Za-z0-9]{1,20}$/);
    });

    test("no session → 401", async () => {
        const r = await runRoute(links.POST, "/api/invoices/payment-links", { store: cookieJar(), method: "POST", body: VALID });
        assert.equal(r.status, 401);
    });

    test("invalid input → 400; another workspace's invoice → 404; paid invoice → 409", async () => {
        const store = await signedIn();
        const bad = await runRoute(links.POST, "/api/invoices/payment-links", { store, method: "POST", body: { ...VALID, amount_ngn: "0" } });
        assert.equal(bad.status, 400);

        handlers["GET /rest/v1/invoices"] = () => supabaseJson(200, null);
        const missing = await runRoute(links.POST, "/api/invoices/payment-links", { store, method: "POST", body: VALID });
        assert.equal(missing.status, 404);

        handlers["GET /rest/v1/invoices"] = () => supabaseJson(200, { id: "inv-1", status: "paid" });
        const paid = await runRoute(links.POST, "/api/invoices/payment-links", { store, method: "POST", body: VALID });
        assert.equal(paid.status, 409);
    });
});

describe("Roqqu webhook", () => {
    test("a completed payment marks the invoice paid and notifies the founder", async () => {
        handlers["GET /rest/v1/invoice_payment_links"] = () => supabaseJson(200, STORED);
        handlers["PATCH /rest/v1/invoice_payment_links"] = () => supabaseJson(200, []);
        handlers["PATCH /rest/v1/invoices"] = () => supabaseJson(200, { client: "Acme" });
        handlers["POST /rest/v1/notifications"] = () => supabaseJson(201, []);
        assert.equal(await deliver(encrypt(paymentEvent())), 200);
        const invoice = requests.find((q) => q.key === "PATCH /rest/v1/invoices");
        assert.equal(invoice.query.id, "eq.inv-1");
        assert.equal(invoice.query.workspace_id, `eq.${WS}`);
        assert.ok(requests.some((q) => q.key === "POST /rest/v1/notifications"));
    });

    test("an underpaid or failed payment leaves the invoice open", async () => {
        handlers["GET /rest/v1/invoice_payment_links"] = () => supabaseJson(200, STORED);
        handlers["PATCH /rest/v1/invoice_payment_links"] = () => supabaseJson(200, []);
        handlers["GET /rest/v1/invoices"] = () => supabaseJson(200, { client: "Acme" });
        handlers["POST /rest/v1/notifications"] = () => supabaseJson(201, []);
        assert.equal(await deliver(encrypt(paymentEvent({ status: "failed" }, "payment_link_failed"))), 200);
        assert.ok(!requests.some((q) => q.key === "PATCH /rest/v1/invoices"));
    });

    test("a repeated delivery changes nothing, and failed never overwrites paid", async () => {
        handlers["GET /rest/v1/invoice_payment_links"] = () => supabaseJson(200, { ...STORED, status: "paid" });
        assert.equal(await deliver(encrypt(paymentEvent())), 200);
        assert.equal(await deliver(encrypt(paymentEvent({ status: "failed" }, "payment_link_failed"))), 200);
        assert.ok(!requests.some((q) => q.key.startsWith("PATCH") || q.key.startsWith("POST /rest")));
    });

    test("forgeries are rejected: wrong key, bad IV, not hex", async () => {
        assert.equal(await deliver(encrypt(paymentEvent(), "x".repeat(40))), 401);
        assert.equal(await deliver(encrypt(paymentEvent()), "not-an-iv"), 401);
        assert.equal(await deliver("zzzz"), 401);
        assert.ok(!requests.some((q) => q.key.includes("/rest/v1/")));
    });

    test("an amount or refid that doesn't match the stored link is rejected", async () => {
        handlers["GET /rest/v1/invoice_payment_links"] = () => supabaseJson(200, STORED);
        assert.equal(await deliver(encrypt(paymentEvent({ amount_required: 1 }))), 401);
        assert.equal(await deliver(encrypt(paymentEvent({ payment_link_refid: "OTHER" }))), 401);
        assert.ok(!requests.some((q) => q.key.startsWith("PATCH")));
    });
});
