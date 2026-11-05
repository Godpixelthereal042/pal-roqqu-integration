import { NextResponse } from "next/server";
import { usesSupabaseData } from "@/lib/data/route";
import { dataErrorResponse, dbError, getSupabaseDataContext, readJson } from "@/lib/data/supabaseContext";
import { createRoqquPaymentLink, newPaymentReference, parsePaymentLinkInput, readRoqquTestKey } from "@/lib/payments/roqqu";

const COLUMNS = "invoice_id, payment_link, amount_required, amount_currency, status, expires_at, created_at";

function toResponse(row: Record<string, any>) {
    return {
        invoice_id: row.invoice_id,
        payment_link: row.payment_link,
        amount_required: row.amount_required,
        amount_currency: row.amount_currency,
        status: row.status,
        expires_at: row.expires_at,
        test_mode: true,
    };
}

const UNAVAILABLE = NextResponse.json({ error: "Roqqu payments need PAL's Supabase data provider" }, { status: 501 });

export async function GET() {
    if (!usesSupabaseData()) return UNAVAILABLE.clone();
    try {
        const { supabase, workspaceId } = await getSupabaseDataContext();
        const { data, error } = await supabase
            .from("invoice_payment_links")
            .select(COLUMNS)
            .eq("workspace_id", workspaceId)
            .order("created_at", { ascending: false });
        if (error) throw dbError(error, "payment links read");
        return NextResponse.json((data ?? []).map(toResponse));
    } catch (error) {
        return dataErrorResponse(error);
    }
}

export async function POST(request: Request) {
    if (!usesSupabaseData()) return UNAVAILABLE.clone();
    try {
        const { supabase, workspaceId, user } = await getSupabaseDataContext();
        const parsed = parsePaymentLinkInput(await readJson(request));
        if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

        const apiKey = readRoqquTestKey();
        const siteUrl = process.env.PAL_SITE_URL?.trim().replace(/\/$/, "");
        if (!apiKey || !siteUrl?.startsWith("https://")) {
            return NextResponse.json({ error: "Roqqu isn't connected yet" }, { status: 503 });
        }

        // RLS: only an invoice in the caller's workspace is visible here.
        const { data: invoice, error: invoiceError } = await supabase
            .from("invoices")
            .select("id, status")
            .eq("workspace_id", workspaceId)
            .eq("id", parsed.input.invoiceId)
            .maybeSingle();
        if (invoiceError) throw dbError(invoiceError, "invoice lookup");
        if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
        if (invoice.status === "paid") return NextResponse.json({ error: "This invoice is already paid" }, { status: 409 });

        // Reuse an open link so one invoice can't have two live ways to pay.
        const { data: existing, error: existingError } = await supabase
            .from("invoice_payment_links")
            .select(COLUMNS)
            .eq("workspace_id", workspaceId)
            .eq("invoice_id", invoice.id)
            .eq("status", "pending")
            .gt("expires_at", new Date().toISOString())
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
        if (existingError) throw dbError(existingError, "open link lookup");
        if (existing) return NextResponse.json(toResponse(existing as Record<string, any>));

        const reference = newPaymentReference();
        let link;
        try {
            link = await createRoqquPaymentLink({ apiKey, input: parsed.input, reference, workspaceId, siteUrl });
        } catch {
            console.error("Roqqu payment link request failed");
            return NextResponse.json({ error: "Roqqu couldn't create the link. Please try again." }, { status: 502 });
        }

        const { data, error } = await supabase
            .from("invoice_payment_links")
            .insert({
                workspace_id: workspaceId,
                invoice_id: invoice.id,
                payment_reference: reference,
                refid: link.refid,
                payment_link: link.paymentLink,
                amount_required: link.amountRequired,
                amount_currency: link.amountCurrency,
                expires_at: link.expiresAt,
                created_by: user.id,
            })
            .select(COLUMNS)
            .single();
        if (error) throw dbError(error, "payment link insert");
        return NextResponse.json(toResponse(data as Record<string, any>), { status: 201 });
    } catch (error) {
        return dataErrorResponse(error);
    }
}
