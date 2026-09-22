"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiDelete } from "@/lib/api";
import { AlertSettings } from "@/lib/types";
import { Plus, Send } from "lucide-react";
import { Button } from "@/components/ui/button";

const TRIGGERS: Record<string, { title: string; detail: string }> = {
  fills: { title: "Entries and exits", detail: "Every fill, with what it booked" },
  move: { title: "Underlying moves", detail: "Each 2% band the underlying crosses" },
  risk: { title: "Risk changes", detail: "Worst-case terminal P&L moving 10%" },
  gateway: { title: "Gateway notices", detail: "Disconnects, failures and 2FA prompts" },
  events: { title: "Event days", detail: "FOMC decisions, holidays and half-days" },
};

export function AlertsPanel() {
  const client = useQueryClient();
  const [pending, setPending] = useState<{ code: string; url: string | null } | null>(null);
  const settings = useQuery({
    queryKey: ["alerts"],
    queryFn: () => api<AlertSettings>("/me/alerts"),
    refetchInterval: pending ? 3000 : false,
  });
  const data = settings.data;

  const link = useMutation({
    mutationFn: () => api<{ code: string; url: string | null }>("/me/alerts/link", {}),
    onSuccess: setPending,
  });
  const unlink = useMutation({
    mutationFn: () => apiDelete<AlertSettings>("/me/alerts/link"),
    onSuccess: () => { setPending(null); client.invalidateQueries({ queryKey: ["alerts"] }); },
  });
  const [movePct, setMovePct] = useState("");
  const [riskPct, setRiskPct] = useState("");
  const [priceDraft, setPriceDraft] = useState("");
  const [moveDraft, setMoveDraft] = useState("");
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api<AlertSettings>("/me/alerts", { triggers: data?.triggers ?? [], ...patch }),
    onSuccess: (next) => client.setQueryData(["alerts"], next),
  });
  const wantedMove = Math.round(Math.abs(Number(moveDraft)) * 10) / 10;
  const canAddMove =
    Number.isFinite(wantedMove) && wantedMove > 0 && wantedMove < 100 &&
    !(settings.data?.move_levels ?? []).includes(String(wantedMove));
  const addMove = () => {
    if (!canAddMove || !settings.data) return;
    save.mutate({ move_levels: [...settings.data.move_levels, String(wantedMove)] });
    setMoveDraft("");
  };
  const wantedPrice = Math.round(Number(priceDraft) * 100) / 100;
  const canAddPrice =
    Number.isFinite(wantedPrice) && wantedPrice > 0 &&
    !(settings.data?.price_levels ?? []).includes(String(wantedPrice));
  const addPrice = () => {
    if (!canAddPrice || !settings.data) return;
    save.mutate({ price_levels: [...settings.data.price_levels, String(wantedPrice)] });
    setPriceDraft("");
  };
  const choose = useMutation({
    mutationFn: (triggers: string[]) => api<AlertSettings>("/me/alerts", { triggers }),
    onSuccess: (next) => client.setQueryData(["alerts"], next),
  });

  if (data?.linked && pending) setPending(null);

  const toggle = (name: string) => {
    const current = data?.triggers ?? [];
    choose.mutate(current.includes(name) ? current.filter(t => t !== name) : [...current, name]);
  };

  return (
    <section className="panel">
      {/* lucide ships no brand marks, so the paper plane stands in for Telegram
          the way it does in most icon sets. */}
      <h2>Alerts<span className="channel"><Send size={13} aria-hidden="true" />Telegram</span></h2>
      {settings.isPending ? (
        <p role="status">Loading alert settings…</p>
      ) : settings.isError ? (
        <p role="alert">Alert settings could not be loaded.</p>
      ) : !data!.configured ? (
        <p className="footnote">
          No Telegram bot is configured for this platform yet, so nothing can be delivered.
          An administrator sets one up once and every member can then connect their own chat.
        </p>
      ) : (
        <>
          <div className="alert-link">
            {data!.linked ? (
              <>
                <p className="linked">
                  <Send size={14} aria-hidden="true" />
                  Connected to <b>{data!.chat_name}</b>. Alerts go to that chat, for the
                  accounts you can already see.
                </p>
                <Button type="button" variant="ghost" size="sm" onClick={() => unlink.mutate()}>
                  Disconnect
                </Button>
              </>
            ) : pending ? (
              <>
                <p>
                  {pending.url ? (
                    <>Open <a href={pending.url} target="_blank" rel="noreferrer">
                      <Send size={13} aria-hidden="true" />this link</a> and
                    press Start. This page will notice once it is done.</>
                  ) : (
                    <>Send <code>/start {pending.code}</code> to the bot. This page will notice
                    once it is done.</>
                  )}
                </p>
                <small>The code is single-use and expires in fifteen minutes.</small>
              </>
            ) : (
              <>
                <p>Connect a Telegram chat to receive alerts.</p>
                <Button type="button" size="sm" disabled={link.isPending} onClick={() => link.mutate()}>
                  <Send size={14} aria-hidden="true" />
                  {link.isPending ? "Preparing…" : "Connect Telegram"}
                </Button>
              </>
            )}
          </div>

          <div className="alert-triggers">
            {data!.available.map(name => (
              <label key={name} className="commission-toggle">
                <input
                  type="checkbox"
                  checked={data!.triggers.includes(name)}
                  disabled={!data!.linked}
                  onChange={() => toggle(name)}
                />
                <span>{TRIGGERS[name]?.title ?? name}</span>
                <small>{TRIGGERS[name]?.detail ?? ""}</small>
              </label>
            ))}
          </div>
          {data!.linked && <div className="alert-thresholds">
            {/* The numbers behind two of the triggers above. They are this
                member's own: one person watches every two percent and another
                only cares about five. */}
            {/* Named levels first: a desk usually wants 2%, 3% and 5%, not
                every multiple of one number. The band below is the fallback. */}
            <label>
              <span>Alert me at these moves</span>
              <span className="level-entry">
                <input
                  type="number" min="0.1" max="99" step="0.1" placeholder="e.g. 3"
                  aria-label="Add a move level, in percent"
                  value={moveDraft}
                  onChange={e => setMoveDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addMove(); } }}
                />
                <Button type="button" variant="outline" size="sm" onClick={addMove} disabled={!canAddMove}>
                  <Plus size={14} aria-hidden="true" />Add
                </Button>
              </span>
              <small>Each one fires when the underlying crosses it, up or down</small>
            </label>
            {data!.move_levels.length > 0 && <span className="level-chips">
              {data!.move_levels.map(level => (
                <button
                  key={level}
                  type="button"
                  className="custom"
                  aria-label={`Remove the ${level}% move alert`}
                  onClick={() => save.mutate({ move_levels: data!.move_levels.filter(l => l !== level) })}
                >
                  ±{level}%<b aria-hidden="true">×</b>
                </button>
              ))}
            </span>}
            <label>
              <span>{data!.move_levels.length ? "Otherwise alert me every" : "Alert me every"}</span>
              <span className="level-entry">
                <input
                  type="number" min={data!.limits?.move_percent?.min ?? 0.1}
                  max={data!.limits?.move_percent?.max ?? 50} step="0.1"
                  aria-label="Underlying move, in percent"
                  value={movePct === "" ? data!.move_percent : movePct}
                  onChange={e => setMovePct(e.target.value)}
                  onBlur={() => { if (movePct !== "") { save.mutate({ move_percent: movePct }); setMovePct(""); } }}
                />
                <b>% move</b>
              </span>
              <small>{data!.move_levels.length
                ? "Unused while specific moves are set above"
                : "Each band the underlying crosses from where it was"}</small>
            </label>
            <label>
              <span>Alert me when risk moves</span>
              <span className="level-entry">
                <input
                  type="number" min={data!.limits?.risk_percent?.min ?? 1}
                  max={data!.limits?.risk_percent?.max ?? 500} step="1"
                  aria-label="Risk change, in percent"
                  value={riskPct === "" ? data!.risk_percent : riskPct}
                  onChange={e => setRiskPct(e.target.value)}
                  onBlur={() => { if (riskPct !== "") { save.mutate({ risk_percent: riskPct }); setRiskPct(""); } }}
                />
                <b>%</b>
              </span>
              <small>Worst-case terminal P&amp;L, against what it was</small>
            </label>
            <label>
              <span>Alert me at a price</span>
              <span className="level-entry">
                <input
                  type="number" min="0.01" step="any" placeholder="e.g. 7800"
                  aria-label="Add a price level to be alerted on"
                  value={priceDraft}
                  onChange={e => setPriceDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addPrice(); } }}
                />
                <Button type="button" variant="outline" size="sm" onClick={addPrice} disabled={!canAddPrice}>
                  <Plus size={14} aria-hidden="true" />Add
                </Button>
              </span>
              <small>When the underlying crosses it, either way</small>
            </label>
            {data!.price_levels.length > 0 && <span className="level-chips">
              {data!.price_levels.map(level => (
                <button
                  key={level}
                  type="button"
                  className="price"
                  aria-label={`Remove the ${level} price alert`}
                  onClick={() => save.mutate({ price_levels: data!.price_levels.filter(l => l !== level) })}
                >
                  {Number(level).toLocaleString()}<b aria-hidden="true">×</b>
                </button>
              ))}
            </span>}
          </div>}
          <p className="footnote">
            Choices are yours alone and apply to this organisation. Switching one off stops
            the message; it does not stop the event being recorded.
          </p>
        </>
      )}
    </section>
  );
}
