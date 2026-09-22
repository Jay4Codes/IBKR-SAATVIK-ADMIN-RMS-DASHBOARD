"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bell, BellOff, Volume2, VolumeX } from "lucide-react";
import { api } from "@/lib/api";
import { LiveEvent } from "@/lib/types";
import { formatTime } from "@/lib/timezone";
import { useZone } from "./timezone";

const SEEN_KEY = "rms.alerts.seen";
const SOUND_KEY = "rms.alerts.sound";

const LABELS: Record<string, string> = {
  fills: "Fill",
  move: "Move",
  risk: "Risk",
  gateway: "Gateway",
  events: "Event",
};

/* Both preferences are read through an external store, the same way the
   timezone picker reads its own. Setting them from an effect instead renders
   once with the default and again with the stored value — a cascading render,
   and a visible flicker on the unread count. */
let listeners: (() => void)[] = [];

function subscribe(notify: () => void) {
  listeners = [...listeners, notify];
  window.addEventListener("storage", notify);
  return () => {
    listeners = listeners.filter(listener => listener !== notify);
    window.removeEventListener("storage", notify);
  };
}

function useStored(key: string, fallback: string): string {
  return useSyncExternalStore(subscribe, () => stored(key, fallback), () => fallback);
}

function stored(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* A preference that cannot be saved still works for this session. */
  }
  // `storage` only fires in *other* tabs, so this tab has to tell itself.
  for (const notify of listeners) notify();
}

function chime(urgent: boolean) {
  type WithWebkit = typeof window & { webkitAudioContext?: typeof AudioContext };
  const Ctor = window.AudioContext ?? (window as WithWebkit).webkitAudioContext;
  if (!Ctor) return;
  let context: AudioContext;
  try {
    context = new Ctor();
  } catch {
    return;
  }
  void context.resume?.().catch(() => {});
  const notes = urgent ? [880, 660, 880] : [660, 880];
  notes.forEach((frequency, index) => {
    const at = context.currentTime + index * 0.14;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(urgent ? 0.22 : 0.12, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.13);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.15);
  });
  window.setTimeout(() => void context.close().catch(() => {}), 900);
}

export function AlertBell() {
  const zone = useZone();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const sound = useStored(SOUND_KEY, "on") === "on";
  const seen = useStored(SEEN_KEY, "");
  const newest = useRef<string>("");
  const primed = useRef(false);

  const feed = useQuery({
    queryKey: ["alerts", "feed"],
    queryFn: () => api<LiveEvent[]>("/alerts?limit=50"),
    staleTime: 60000,
  });
  const rows = feed.data ?? [];
  const unread = rows.filter(row => row.timestamp > seen).length;

  useEffect(() => {
    const top = rows[0];
    if (!top) return;
    const id = top.event_id ?? top.timestamp;
    if (!primed.current) {
      primed.current = true;
      newest.current = id;
      return;
    }
    if (id === newest.current) return;
    newest.current = id;
    if (sound && top.timestamp > seen) chime(Boolean(top.data?.urgent));
  }, [rows, sound, seen]);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (container.current && !container.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    // Captured, so a click on something that stops propagation still closes it.
    document.addEventListener("click", away, true);
    return () => document.removeEventListener("click", away, true);
  }, [open]);

  const markSeen = () => {
    // The newest timestamp, not the first row: the feed is sorted newest-first
    // and live ones are prepended, but reading the marker off position alone
    // would silently leave an alert unread if that ever stopped being true.
    const newestStamp = rows.reduce(
      (latest, row) => (row.timestamp > latest ? row.timestamp : latest),
      "",
    );
    remember(SEEN_KEY, newestStamp || new Date().toISOString());
  };

  const toggleSound = () => {
    const next = !sound;
    remember(SOUND_KEY, next ? "on" : "off");
    if (next) chime(false);
  };

  return (
    <div className="alert-bell" ref={container}>
      <button
        type="button"
        className="bell-button"
        aria-label={unread ? `Alerts, ${unread} unread` : "Alerts"}
        aria-expanded={open}
        onClick={() => { setOpen(!open); if (!open) markSeen(); }}
      >
        {unread ? <Bell size={16} aria-hidden="true" /> : <BellOff size={16} aria-hidden="true" />}
        {unread > 0 && <b>{unread > 99 ? "99+" : unread}</b>}
      </button>
      {open && (
        <div className="bell-panel" role="dialog" aria-label="Recent alerts">
          <header>
            <span>Alerts</span>
            <button
              type="button"
              onClick={toggleSound}
              aria-label={sound ? "Mute alert sound" : "Unmute alert sound"}
              title={sound ? "Sound on" : "Sound off"}
            >
              {sound ? <Volume2 size={14} aria-hidden="true" /> : <VolumeX size={14} aria-hidden="true" />}
            </button>
          </header>
          {feed.isPending ? (
            <p role="status">Loading alerts…</p>
          ) : rows.length === 0 ? (
            <p className="footnote">
              No alerts yet. They arrive here and in Telegram once a fill, a move,
              a risk change or a gateway notice happens.
            </p>
          ) : (
            <ul>
              {rows.map(row => (
                <li key={row.event_id ?? row.timestamp} className={row.data?.urgent ? "urgent" : ""}>
                  <span className="tag">{LABELS[String(row.data?.trigger)] ?? "Alert"}</span>
                  <p>{String(row.data?.plain ?? "")}</p>
                  <time>{formatTime(row.timestamp, zone)}</time>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
