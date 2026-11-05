/**
 * Applies a verified Roqqu webhook event to PAL. Uses the privileged client
 * because a webhook has no signed-in user; the workspace comes from the
 * decrypted event and must match the link PAL stored when it was created.
 */

import { createPrivilegedSupabaseClient } from "./privilegedSupabase";
import type { RoqquPaymentEvent } from "../payments/roqqu";

export type ApplyResult = "applied" | "unchanged" | "unknown_link" | "mismatch";

export async function applyRoqquPaymentEvent(event: RoqquPaymentEvent): Promise<ApplyResult> {
    const supabase = createPrivilegedSupabaseClient({
        purpose: "billing",
        workspaceId: event.workspaceId,
        reason: `roqqu webhook ${event.outcome}`,
    });

    const { data: link, error } = await supabase
        .from("invoice_payment_links")
        .select("id, invoice_id, refid, status, amount_required, amount_currency, created_by")
        .eq("workspace_id", event.workspaceId)
        .eq("payment_reference", event.reference)
        .maybeSingle();
    if (error) throw new Error("payment link lookup failed");
    if (!link) return "unknown_link";

    if (link.refid !== event.refid || link.amount_currency !== event.amountCurrency || Number(link.amount_required) !== Number(event.amountRequired)) {
        return "mismatch";
    }
    // Deliveries can repeat or arrive late: a paid link never goes backwards.
    if (link.status === "paid" || link.status === event.outcome) return "unchanged";

    const { error: linkError } = await supabase
        .from("invoice_payment_links")
        .update({ status: event.outcome, transaction_hash: event.transactionHash })
        .eq("id", link.id);
    if (linkError) throw new Error("payment link update failed");

    const { data: invoice, error: invoiceError } = event.outcome === "paid"
        ? await supabase.from("invoices").update({ status: "paid" }).eq("workspace_id", event.workspaceId).eq("id", link.invoice_id).select("client").maybeSingle()
        : await supabase.from("invoices").select("client").eq("workspace_id", event.workspaceId).eq("id", link.invoice_id).maybeSingle();
    if (invoiceError) throw new Error("invoice update failed");

    if (link.created_by) {
        const client = invoice?.client ?? "Your client";
        const { error: notifyError } = await supabase.from("notifications").insert({
            workspace_id: event.workspaceId,
            user_id: link.created_by,
            category: "invoices",
            title: event.outcome === "paid" ? `${client} paid` : `${client}'s payment didn't complete`,
            text: event.outcome === "paid"
                ? "Roqqu confirmed the payment. PAL marked the invoice as paid."
                : "Roqqu reported a failed or underpaid payment. The invoice is still open.",
            action_label: "View invoices",
            action_route: "/quick-invoice",
            priority: "high",
        });
        // The payment state is already saved; a missed notice must not make Roqqu retry.
        if (notifyError) console.error("Roqqu notification failed");
    }
    return "applied";
}
