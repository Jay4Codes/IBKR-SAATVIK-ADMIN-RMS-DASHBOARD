import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AlertBell } from "@/components/alert-bell";
import { applyEvent } from "@/lib/live";
import { LiveEvent } from "@/lib/types";

function alert(fields: Partial<LiveEvent> = {}, data: Record<string, unknown> = {}): LiveEvent {
  return {
    event_id: "e1", event_type: "alert.raised", account_id: "U1",
    timestamp: "2026-09-14T18:00:00Z",
    data: { trigger: "fills", plain: "Sold 1 × SPXW", text: "<b>Sold</b>", urgent: false, ...data },
    ...fields,
  } as LiveEvent;
}

function stubFetch(rows: LiveEvent[]) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ success: true, data: rows }),
  })));
}

let client: QueryClient;
function wrapper() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

function mount() {
  return render(<AlertBell />, { wrapper: wrapper() });
}

beforeEach(() => {
  localStorage.clear();
  // jsdom has no audio; the bell must survive that rather than throw.
  vi.stubGlobal("AudioContext", undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe("alert bell", () => {
  it("counts what has arrived since the reader last looked", async () => {
    // Newest first, the way the feed endpoint returns them.
    stubFetch([alert({ event_id: "e2", timestamp: "2026-09-14T18:05:00Z" }), alert()]);
    mount();
    const bell = await screen.findByRole("button", { name: /Alerts, 2 unread/ });
    fireEvent.click(bell);
    // Opening is reading: the count clears and the list is shown.
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Recent alerts" })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Alerts" })).toBeInTheDocument());
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("shows the plain text, not the markup Telegram was sent", async () => {
    stubFetch([alert({}, { plain: "Sold 1 × SPXW at 11.83", text: "<b>Sold</b> 1" })]);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Alerts/ }));
    expect(screen.getByText("Sold 1 × SPXW at 11.83")).toBeInTheDocument();
    expect(screen.queryByText(/<b>/)).toBeNull();
  });

  it("puts a live alert at the top of the feed without a refetch", async () => {
    stubFetch([alert()]);
    mount();
    await screen.findByRole("button", { name: /Alerts, 1 unread/ });
    applyEvent(client, alert({ event_id: "e9", timestamp: "2026-09-14T18:09:00Z" }, { plain: "Gateway Disconnected", trigger: "gateway", urgent: true }));
    await screen.findByRole("button", { name: /Alerts, 2 unread/ });
    fireEvent.click(screen.getByRole("button", { name: /Alerts/ }));
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Gateway Disconnected");
    // Urgent ones are marked so they read differently at a glance.
    expect(items[0].className).toContain("urgent");
  });

  it("remembers the sound choice and survives a browser with no audio", async () => {
    stubFetch([alert()]);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Alerts/ }));
    // No AudioContext in jsdom: toggling must not throw.
    fireEvent.click(screen.getByRole("button", { name: "Mute alert sound" }));
    expect(localStorage.getItem("rms.alerts.sound")).toBe("off");
    expect(screen.getByRole("button", { name: "Unmute alert sound" })).toBeInTheDocument();
  });

  it("closes when the click lands outside the panel", async () => {
    stubFetch([alert()]);
    render(
      <>
        <AlertBell />
        <button type="button">elsewhere</button>
      </>,
      { wrapper: wrapper() },
    );
    fireEvent.click(await screen.findByRole("button", { name: /Alerts/ }));
    expect(screen.getByRole("dialog", { name: "Recent alerts" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(screen.queryByRole("dialog", { name: "Recent alerts" })).not.toBeInTheDocument();
  });

  it("stays open while the click is inside the panel", async () => {
    stubFetch([alert()]);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Alerts/ }));
    fireEvent.click(screen.getByRole("dialog", { name: "Recent alerts" }));
    expect(screen.getByRole("dialog", { name: "Recent alerts" })).toBeInTheDocument();
  });

  it("says so plainly when there is nothing to show", async () => {
    stubFetch([]);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Alerts" }));
    expect(screen.getByText(/No alerts yet/)).toBeInTheDocument();
  });

  it("keeps working when storage is unavailable", async () => {
    const boom = () => { throw new Error("denied"); };
    vi.stubGlobal("localStorage", { getItem: boom, setItem: boom, clear: boom });
    stubFetch([alert()]);
    mount();
    // A private window cannot persist the read marker; the bell still renders.
    expect(await screen.findByRole("button", { name: /Alerts/ })).toBeInTheDocument();
  });
});
