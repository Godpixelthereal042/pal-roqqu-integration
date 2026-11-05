import { NextResponse } from "next/server";
import { decryptRoqquWebhook, readRoqquPaymentEvent, readRoqquTestKey } from "@/lib/payments/roqqu";
import { applyRoqquPaymentEvent } from "@/lib/server/roqquPayments";

/** Roqqu payment-link webhook. Public, so nothing is trusted until it decrypts and matches a stored link. */
export async function POST(request: Request) {
    const apiKey = readRoqquTestKey();
    if (!apiKey) return NextResponse.json({ error: "Not configured" }, { status: 503 });

    const body = (await request.json().catch(() => null)) as { hash?: unknown } | null;
    const iv = request.headers.get("x-api-key") ?? request.headers.get("x-staging-api-key");
    const decrypted = decryptRoqquWebhook(body?.hash, apiKey, iv);
    if (!decrypted) return NextResponse.json({ error: "Invalid webhook" }, { status: 401 });

    const event = readRoqquPaymentEvent(decrypted);
    if (!event) return NextResponse.json({ received: true });

    try {
        const result = await applyRoqquPaymentEvent(event);
        if (result === "mismatch") return NextResponse.json({ error: "Invalid webhook" }, { status: 401 });
        return NextResponse.json({ received: true });
    } catch {
        console.error("Roqqu webhook processing failed");
        return NextResponse.json({ error: "Could not process webhook" }, { status: 500 });
    }
}
