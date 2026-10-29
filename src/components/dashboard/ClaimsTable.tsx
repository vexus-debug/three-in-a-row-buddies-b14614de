import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { ShieldCheck, Search, Send, Loader2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { TableSkeleton } from "@/components/dashboard/TableSkeleton";
import { useInsuranceClaims, useUpdateClaim, CLAIM_STATUSES } from "@/hooks/useBilling";
import { filterClaims } from "@/lib/printDocs";
import { cn } from "@/lib/utils";

const fmt = (n: number) => `₦${Number(n || 0).toLocaleString()}`;
const statusTone: Record<string, string> = {
  draft: "bg-muted text-muted-foreground border-border",
  submitted: "bg-primary/10 text-primary border-primary/20",
  pending: "bg-accent text-accent-foreground border-border",
  paid: "bg-secondary/15 text-secondary border-secondary/30",
  denied: "bg-destructive/10 text-destructive border-destructive/20",
};

/** Insurance claims list. Claims are drafted from an invoice (Invoice → "Insurance claim"). */
export function ClaimsTable() {
  const { data: claims = [], isLoading } = useInsuranceClaims();
  const update = useUpdateClaim();
  const [status, setStatusFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batching, setBatching] = useState(false);
  const [noteFor, setNoteFor] = useState<{ claim: any; status: string } | null>(null);
  const [noteText, setNoteText] = useState("");

  const rows = useMemo(() => filterClaims(claims, status, query), [claims, status, query]);
  const drafts = rows.filter((c: any) => c.status === "draft");
  const allDraftsSelected = drafts.length > 0 && drafts.every((c: any) => selected.has(c.id));

  const applyStatus = async (c: any, next: string, notes?: string) => {
    const today = new Date().toISOString().slice(0, 10);
    await update.mutateAsync({
      id: c.id,
      status: next,
      submitted_date: next === "submitted" ? c.submitted_date || today : c.submitted_date,
      paid_date: next === "paid" ? today : next === "denied" ? null : c.paid_date,
      amount_paid: next === "paid" ? Number(c.amount_claimed) : c.amount_paid,
      ...(notes !== undefined ? { notes } : {}),
    });
  };

  const onStatusChange = async (c: any, next: string) => {
    if (next === "denied" || next === "pending") {
      setNoteText(c.notes || "");
      setNoteFor({ claim: c, status: next });
      return;
    }
    try {
      await applyStatus(c, next);
      toast({ title: `Claim marked ${next}` });
    } catch (e: any) {
      toast({ title: "Could not update claim", description: e.message, variant: "destructive" });
    }
  };

  const saveNote = async () => {
    if (!noteFor) return;
    try {
      await applyStatus(noteFor.claim, noteFor.status, noteText.trim() || null as any);
      toast({ title: `Claim marked ${noteFor.status}` });
      setNoteFor(null);
    } catch (e: any) {
      toast({ title: "Could not update claim", description: e.message, variant: "destructive" });
    }
  };

  const submitSelected = async () => {
    const targets = claims.filter((c: any) => selected.has(c.id) && c.status === "draft");
    setBatching(true);
    const results = await Promise.allSettled(targets.map((c: any) => applyStatus(c, "submitted")));
    setBatching(false);
    const failed = results.filter((r) => r.status === "rejected").length;
    setSelected(new Set());
    toast(failed
      ? { title: `${targets.length - failed} submitted, ${failed} failed`, variant: "destructive" }
      : { title: `${targets.length} claim${targets.length === 1 ? "" : "s"} submitted` });
  };

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = () => setSelected(allDraftsSelected ? new Set() : new Set(drafts.map((c: any) => c.id)));

  return (
    <Card className="border-border bg-card shadow-sm overflow-hidden">
      <CardHeader className="pb-3 border-b border-border/50 space-y-3">
        <div>
          <CardTitle className="text-[15px] font-semibold">Insurance claims</CardTitle>
          <CardDescription className="text-xs">Open an invoice and choose "Insurance claim" to draft a new one.</CardDescription>
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search patient, insurer, policy or invoice" className="pl-9 h-9" aria-label="Search claims" />
          </div>
          <div className="flex gap-1 flex-wrap" role="tablist" aria-label="Filter by status">
            {["all", ...CLAIM_STATUSES].map((s) => (
              <Button key={s} size="sm" variant={status === s ? "default" : "outline"} className="h-9 capitalize text-xs" onClick={() => setStatusFilter(s)} aria-pressed={status === s}>
                {s}
              </Button>
            ))}
          </div>
        </div>
        {selected.size > 0 && (
          <div className="flex items-center justify-between rounded-md border border-primary/20 bg-primary/5 px-3 py-2">
            <span className="text-xs font-medium">{selected.size} draft claim{selected.size === 1 ? "" : "s"} selected</span>
            <Button size="sm" className="h-8" onClick={submitSelected} disabled={batching}>
              {batching ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}
              Submit selected claims
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <TableSkeleton columns={7} rows={4} />
        ) : claims.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="No claims yet" description="Claims you draft from invoices will appear here." />
        ) : rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">No claims match these filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/30 border-b border-border/50 text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="py-3 pl-4 w-8">
                    <Checkbox checked={allDraftsSelected} onCheckedChange={toggleAll} disabled={drafts.length === 0} aria-label="Select all draft claims" />
                  </th>
                  <th className="py-3 px-4 text-left font-semibold">Invoice</th>
                  <th className="py-3 px-4 text-left font-semibold">Patient</th>
                  <th className="py-3 px-4 text-left font-semibold hidden md:table-cell">Insurer</th>
                  <th className="py-3 px-4 text-right font-semibold">Claimed</th>
                  <th className="py-3 px-4 text-right font-semibold hidden md:table-cell">Paid</th>
                  <th className="py-3 px-4 text-left font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c: any) => (
                  <tr key={c.id} className="border-b border-border/30 last:border-0 align-top">
                    <td className="py-3 pl-4">
                      {c.status === "draft" && <Checkbox checked={selected.has(c.id)} onCheckedChange={() => toggle(c.id)} aria-label={`Select claim ${c.invoices?.invoice_number || ""}`} />}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-primary font-semibold">{c.invoices?.invoice_number || "—"}</td>
                    <td className="py-3 px-4 font-medium">
                      {c.patients ? `${c.patients.first_name} ${c.patients.last_name}` : "—"}
                      {c.notes && (c.status === "denied" || c.status === "pending") && (
                        <span className="block text-[11px] font-normal text-muted-foreground max-w-[220px]">Note: {c.notes}</span>
                      )}
                    </td>
                    <td className="py-3 px-4 hidden md:table-cell text-muted-foreground">
                      {c.insurer_name}
                      {c.policy_number && <span className="block text-[11px]">Policy {c.policy_number}</span>}
                    </td>
                    <td className="py-3 px-4 text-right tabular-nums font-semibold">{fmt(c.amount_claimed)}</td>
                    <td className="py-3 px-4 text-right tabular-nums hidden md:table-cell text-muted-foreground">{fmt(c.amount_paid)}</td>
                    <td className="py-3 px-4">
                      <Select value={c.status} onValueChange={(v) => onStatusChange(c, v)}>
                        <SelectTrigger className={cn("h-7 w-[120px] text-[11px] font-semibold capitalize border", statusTone[c.status])}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CLAIM_STATUSES.map((s) => (
                            <SelectItem key={s} value={s} className="capitalize text-xs">{s}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>

      <Dialog open={!!noteFor} onOpenChange={(o) => !o && setNoteFor(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="capitalize">Mark claim {noteFor?.status}</DialogTitle>
            <DialogDescription>
              {noteFor?.status === "denied" ? "Record the insurer's denial reason and EOB reference." : "Add a pre-authorisation or follow-up note."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="claim-note" className="text-xs">Note / EOB reference</Label>
            <Textarea id="claim-note" rows={3} value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="e.g. EOB #48213 — frequency limit exceeded" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNoteFor(null)}>Cancel</Button>
            <Button onClick={saveNote} disabled={update.isPending || (noteFor?.status === "denied" && !noteText.trim())}>
              {update.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
