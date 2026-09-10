import { Gateway } from "./types";

export type LoginPhase =
  | "logged_in"
  | "starting"
  | "connecting"
  | "connecting_stale"
  | "two_factor"
  | "two_factor_expired"
  | "two_factor_device_required"
  | "auth_failed"
  | "down";

const LABELS: Record<LoginPhase, string> = {
  logged_in: "Logged in",
  starting: "Starting",
  connecting: "Connecting",
  connecting_stale: "Stuck connecting",
  two_factor: "Two-factor pending",
  two_factor_expired: "Two-factor expired",
  two_factor_device_required: "2FA device not set",
  auth_failed: "Login rejected",
  down: "Gateway down",
};

export const HEALTHY: LoginPhase[] = ["logged_in"];
const FAULTED: LoginPhase[] = [
  "two_factor_expired",
  "two_factor_device_required",
  "auth_failed",
  "connecting_stale",
  "down",
];

export function phaseLabel(phase?: string, remaining?: number | null): string {
  if (phase === "two_factor" && remaining != null && remaining > 0) {
    return `Two-factor · ${remaining}s`;
  }
  return LABELS[phase as LoginPhase] ?? "Unknown";
}

export function phaseTone(phase?: string): "positive" | "negative" | "warn" {
  if (!phase) return "warn";
  if (HEALTHY.includes(phase as LoginPhase)) return "positive";
  return FAULTED.includes(phase as LoginPhase) ? "negative" : "warn";
}

export function twoFactorRemaining(
  gateway: Gateway | undefined,
  clock: number,
): number | null {
  const timeout = gateway?.two_factor_timeout_seconds ?? null;
  const startedAt = gateway?.two_factor_started_at ?? null;
  const started = startedAt ? Date.parse(startedAt) : NaN;
  if (
    gateway?.login_phase !== "two_factor" ||
    !timeout ||
    Number.isNaN(started) ||
    !clock
  ) {
    return gateway?.two_factor_remaining_seconds ?? null;
  }
  return Math.max(0, Math.floor(timeout - (clock - started) / 1000));
}

export function effectivePhase(
  gateway: Gateway | undefined,
  remaining: number | null,
): string | undefined {
  const phase = gateway?.login_phase;
  return phase === "two_factor" && remaining != null && remaining <= 0
    ? "two_factor_expired"
    : phase;
}

export function isAwaitingTwoFactor(
  gateway: Gateway | undefined,
  remaining: number | null,
): boolean {
  return gateway?.login_phase === "two_factor" && (remaining ?? 0) > 0;
}
