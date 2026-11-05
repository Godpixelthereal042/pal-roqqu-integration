/**
 * Roqqu API Service (RAS) payment links.
 * Docs: https://roqqu-api-services.gitbook.io/ras
 *
 * TEST MODE ONLY. PAL reads ROQQU_TEST_API_KEY and sends it as
 * x-staging-api-key. There is no code path that sends a live key.
 */

import { createDecipheriv, randomBytes } from "node:crypto";

export const ROQQU_BASE_URL = "https://service.roqqu.com/v1";
const LINK_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

export function readRoqquTestKey(env: Record<string, string | undefined> = process.env): string | null {
    const key = env.ROQQU_TEST_API_KEY?.trim();
    return key && key.length >= 32 ? key : null;
}

/** Roqqu requires 1-20 alphanumeric characters. */
export function newPaymentReference(): string {
    return `PAL${randomBytes(8).toString("hex")}`;
}

export interface PaymentLinkInput {
    invoiceId: string;
    email: string;
    firstName: string;
    lastName: string;
    amountNgn: string;
}

function text(value: unknown, max: number): string {
    return typeof value === "string" ? value.trim().slice(0, max + 1) : "";
}

/** The founder confirms who pays and the naira amount. PAL never converts currency itself. */
export function parsePaymentLinkInput(body: Record<string, unknown>): { ok: true; input: PaymentLinkInput } | { ok: false; error: string } {
    const invoiceId = text(body.invoice_id, 100);
    const email = text(body.email, 200);
    const firstName = text(body.first_name, 100);
    const lastName = text(body.last_name, 100);
    const rawAmount = typeof body.amount_ngn === "number" ? String(body.amount_ngn) : text(body.amount_ngn, 30).replace(/,/g, "");

    if (!invoiceId || invoiceId.length > 100) return { ok: false, error: "Invoice is required" };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return { ok: false, error: "Enter your client's email" };
    if (!firstName || firstName.length > 100 || !lastName || lastName.length > 100) return { ok: false, error: "Enter your client's first and last name" };
    if (!/^\d+(\.\d{1,2})?$/.test(rawAmount) || !(Number(rawAmount) > 0)) return { ok: false, error: "Enter an amount in naira greater than 0" };

    return { ok: true, input: { invoiceId, email, firstName, lastName, amountNgn: String(Number(rawAmount)) } };
}

export interface RoqquPaymentLink {
    refid: string;
    paymentLink: string;
    amountRequired: string;
    amountCurrency: string;
    expiresAt: string;
}

export class RoqquRequestError extends Error {
    readonly status: number;
    constructor(status: number) {
        super(`Roqqu request failed with status ${status}`);
        this.name = "RoqquRequestError";
        this.status = status;
    }
}

export async function createRoqquPaymentLink(args: {
    apiKey: string;
    input: PaymentLinkInput;
    reference: string;
    workspaceId: string;
    siteUrl: string;
    now?: Date;
    fetchImpl?: typeof fetch;
}): Promise<RoqquPaymentLink> {
    const { apiKey, input, reference, workspaceId, siteUrl, now = new Date(), fetchImpl = fetch } = args;
    const params = new URLSearchParams({
        amount: input.amountNgn,
        amount_currency: "ngn",
        payment_reference: reference,
        customer_details: JSON.stringify({ email: input.email, first_name: input.firstName, last_name: input.lastName }),
        success_url: `${siteUrl}/quick-invoice?payment=success`,
        cancel_url: `${siteUrl}/quick-invoice?payment=cancelled`,
        expires_at: new Date(now.getTime() + LINK_LIFETIME_MS).toISOString(),
        // Returned inside the encrypted webhook, which is how PAL finds the workspace.
        metadata: JSON.stringify({ workspace_id: workspaceId, invoice_id: input.invoiceId }),
    });

    const res = await fetchImpl(`${ROQQU_BASE_URL}/payment-links`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "x-staging-api-key": apiKey },
        body: params.toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new RoqquRequestError(res.status);

    const json = (await res.json().catch(() => null)) as { data?: Record<string, unknown> } | null;
    const data = json?.data;
    const refid = typeof data?.refid === "string" ? data.refid : "";
    const paymentLink = typeof data?.payment_link === "string" ? data.payment_link : "";
    if (!refid || !paymentLink.startsWith("https://")) throw new RoqquRequestError(502);

    return {
        refid,
        paymentLink,
        amountRequired: String(data?.amount_required ?? input.amountNgn),
        amountCurrency: String(data?.amount_currency ?? "ngn").toLowerCase(),
        expiresAt: typeof data?.expires_at === "string" ? data.expires_at : new Date(now.getTime() + LINK_LIFETIME_MS).toISOString(),
    };
}

/**
 * AES-256-CTR, key = first 32 characters of the API key, IV = the webhook's
 * x-api-key header (hex). Returns null for anything that does not decrypt to a
 * JSON object: CTR has no integrity check, so that JSON test plus the checks
 * against PAL's stored link (see lib/server/roqquPayments.ts) reject forgeries.
 */
export function decryptRoqquWebhook(hash: unknown, apiKey: string, iv: string | null): Record<string, unknown> | null {
    if (typeof hash !== "string" || !/^([0-9a-f]{2})+$/i.test(hash)) return null;
    if (!iv || !/^[0-9a-f]{32}$/i.test(iv)) return null;
    try {
        const decipher = createDecipheriv("aes-256-ctr", Buffer.from(apiKey.slice(0, 32), "utf8"), Buffer.from(iv, "hex"));
        const plain = Buffer.concat([decipher.update(Buffer.from(hash, "hex")), decipher.final()]).toString("utf8");
        const parsed: unknown = JSON.parse(plain);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

export interface RoqquPaymentEvent {
    outcome: "paid" | "failed";
    reference: string;
    refid: string;
    workspaceId: string;
    amountRequired: string;
    amountCurrency: string;
    transactionHash: string | null;
}

/** Null when the event is not a payment-link outcome PAL can attribute. */
export function readRoqquPaymentEvent(event: Record<string, unknown>): RoqquPaymentEvent | null {
    const meta = event.meta_data as Record<string, unknown> | undefined;
    if (!meta || typeof meta !== "object") return null;

    const type = event.event_type;
    let outcome: "paid" | "failed";
    if ((type === "payment_link_completed" || type === "payment_link_completed_overpaid") && meta.status === "completed") outcome = "paid";
    else if (type === "payment_link_failed") outcome = "failed";
    else return null;

    let metadata = meta.metadata as unknown;
    if (typeof metadata === "string") {
        try {
            metadata = JSON.parse(metadata);
        } catch {
            return null;
        }
    }
    const workspaceId = (metadata as Record<string, unknown> | null)?.workspace_id;
    if (typeof workspaceId !== "string" || !workspaceId) return null;
    if (typeof meta.payment_reference !== "string" || typeof meta.payment_link_refid !== "string") return null;

    return {
        outcome,
        reference: meta.payment_reference,
        refid: meta.payment_link_refid,
        workspaceId,
        amountRequired: String(meta.amount_required ?? ""),
        amountCurrency: String(meta.amount_currency ?? "").toLowerCase(),
        transactionHash: typeof meta.hash === "string" ? meta.hash : null,
    };
}
