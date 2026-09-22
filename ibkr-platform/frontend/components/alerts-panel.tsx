"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiDelete } from "@/lib/api";
import { AlertChannel, AlertSettings } from "@/lib/types";
import { Plus, Send } from "lucide-react";
import { Button } from "@/components/ui/button";

const TRIGGERS: Record<string, { title: string; detail: string }> = {
  fills: { title: "Entries and exits", detail: "Every fill, with what it booked" },
  move: { title: "Underlying moves", detail: "Each 2% band the underlying crosses" },
  risk: { title: "Risk changes", detail: "Worst-case terminal P&L moving 10%" },
  gateway: { title: "Gateway notices", detail: "Disconnects, failures and 2FA prompts" },
  events: { title: "Event days", detail: "FOMC decisions, holidays and half-days" },
};

type Limits = AlertSettings["limits"];

function ChannelControls({
  label,
  note,
  prefs,
  limits,
  disabled,
  showThresholds,
  onSave,
}: {
  label: string;
  note: string;
  prefs: AlertChannel;
  limits: Limits;
  disabled?: boolean;
  showThresholds: boolean;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const [movePct, setMovePct] = useState("");
  const [riskPct, setRiskPct] = useState("");
  const [priceDraft, setPriceDraft] = useState("");
  const [moveDraft, setMoveDraft] = useState("");
  const wantedMove = Math.round(Math.abs(Number(moveDraft)) * 10) / 10;
  const canAddMove =
    Number.isFinite(wantedMove) && wantedMove > 0 && wantedMove < 100 &&
    !prefs.move_levels.includes(String(wantedMove));
  const addMove = () => {
    if (!canAddMove) return;
    onSave({ triggers: prefs.triggers, move_levels: [...prefs.move_levels, String(wantedMove)] });
    setMoveDraft("");
  };
  const wantedPrice = Math.round(Number(priceDraft) * 100) / 100;
  const canAddPrice =
    Number.isFinite(wantedPrice) && wantedPrice > 0 &&
    !prefs.price_levels.includes(String(wantedPrice));
  const addPrice = () => {
    if (!canAddPrice) return;
    onSave({ triggers: prefs.triggers, price_levels: [...prefs.price_levels, String(wantedPrice)] });
    setPriceDraft("");
  };
  const toggle = (name: string) => {
    const next = prefs.triggers.includes(name)
      ? prefs.triggers.filter(t => t !== name)
      : [...prefs.triggers, name];
    onSave({ triggers: next });
  };

  return (
    <>
      <h3 className="alert-channel">
        {label}
        <small>{note}</small>
      </h3>
      <div className="alert-triggers" role="group" aria-label={label}>
        {prefs.available.map(name => (
          <label key={name} className="commission-toggle">
            <input
              type="checkbox"
              checked={prefs.triggers.includes(name)}
              disabled={disabled}
              onChange={() => toggle(name)}
            />
            <span>{TRIGGERS[name]?.title ?? name}</span>
            <small>{TRIGGERS[name]?.detail ?? ""}</small>
          </label>
        ))}
      </div>
      {showThresholds && <div className="alert-thresholds">
        <label>
          <span>Alert me at these moves</span>
          <span className="level-entry">
            <input
              type="number" min="0.1" max="99" step="0.1" placeholder="e.g. 3"
              aria-label={`${label} move level, in percent`}
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
        {prefs.move_levels.length > 0 && <span className="level-chips">
          {prefs.move_levels.map(level => (
            <button
              key={level}
              type="button"
              className="custom"
              aria-label={`Remove the ${level}% move alert from ${label}`}
              onClick={() => onSave({ triggers: prefs.triggers, move_levels: prefs.move_levels.filter(l => l !== level) })}
            >
              ±{level}%<b aria-hidden="true">×</b>
            </button>
          ))}
        </span>}
        <label>
          <span>{prefs.move_levels.length ? "Otherwise alert me every" : "Alert me every"}</span>
          <span className="level-entry">
            <input
              type="number" min={limits?.move_percent?.min ?? 0.1}
              max={limits?.move_percent?.max ?? 50} step="0.1"
              aria-label={`${label} underlying move, in percent`}
              value={movePct === "" ? prefs.move_percent : movePct}
              onChange={e => setMovePct(e.target.value)}
              onBlur={() => { if (movePct !== "") { onSave({ triggers: prefs.triggers, move_percent: movePct }); setMovePct(""); } }}
            />
            <b>% move</b>
          </span>
          <small>{prefs.move_levels.length
            ? "Unused while specific moves are set above"
            : "Each band the underlying crosses from where it was"}</small>
        </label>
        <label>
          <span>Alert me when risk moves</span>
          <span className="level-entry">
            <input
              type="number" min={limits?.risk_percent?.min ?? 1}
              max={limits?.risk_percent?.max ?? 500} step="1"
              aria-label={`${label} risk change, in percent`}
              value={riskPct === "" ? prefs.risk_percent : riskPct}
              onChange={e => setRiskPct(e.target.value)}
              onBlur={() => { if (riskPct !== "") { onSave({ triggers: prefs.triggers, risk_percent: riskPct }); setRiskPct(""); } }}
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
              aria-label={`${label} price level`}
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
        {prefs.price_levels.length > 0 && <span className="level-chips">
          {prefs.price_levels.map(level => (
            <button
              key={level}
              type="button"
              className="price"
              aria-label={`Remove the ${level} price alert from ${label}`}
              onClick={() => onSave({ triggers: prefs.triggers, price_levels: prefs.price_levels.filter(l => l !== level) })}
            >
              {Number(level).toLocaleString()}<b aria-hidden="true">×</b>
            </button>
          ))}
        </span>}
      </div>}
    </>
  );
}

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
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api<AlertSettings>("/me/alerts", patch),
    onSuccess: (next) => client.setQueryData(["alerts"], next),
  });

  if (data?.linked && pending) setPending(null);

  const personal: AlertChannel | null = data ? {
    triggers: data.triggers,
    available: data.available,
    move_percent: data.move_percent,
    risk_percent: data.risk_percent,
    price_levels: data.price_levels,
    move_levels: data.move_levels,
  } : null;

  return (
    <section className="panel">

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

          {personal && (
            <ChannelControls
              label="Your chat"
              note="Only the chat you connected"
              prefs={personal}
              limits={data!.limits}
              disabled={!data!.linked}
              showThresholds={data!.linked}
              onSave={(patch) => save.mutate(patch)}
            />
          )}
          {data!.common && (
            <ChannelControls
              label="Common channel"
              note="Shared desk chat"
              prefs={data!.common}
              limits={data!.limits}
              showThresholds
              onSave={(patch) => save.mutate({ channel: "common", ...patch })}
            />
          )}
          <p className="footnote">
            {data!.common
              ? "Each channel keeps its own choices. Entries and exits stay off for your chat, the common channel, and the alert bell until you turn them on for a channel. Switching one off stops the message; it does not stop the event being recorded."
              : "Entries and exits stay off until you turn them on. Switching one off stops the message; it does not stop the event being recorded."}
          </p>
        </>
      )}
    </section>
  );
}
