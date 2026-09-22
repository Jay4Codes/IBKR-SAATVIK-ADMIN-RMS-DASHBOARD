import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AlertsPanel } from "@/components/alerts-panel";
import { AlertSettings } from "@/lib/types";

const limits = {
  move_percent: { default: 2, min: 0.1, max: 50 },
  risk_percent: { default: 10, min: 1, max: 500 },
};

function settings(common: AlertSettings["common"]): AlertSettings {
  return {
    configured: true,
    linked: true,
    chat_name: "jay",
    triggers: ["fills", "move", "risk", "gateway", "events"],
    available: ["fills", "move", "risk", "gateway", "events"],
    move_percent: "2.0",
    risk_percent: "10.0",
    price_levels: [],
    move_levels: [],
    limits,
    common,
  };
}

const shared = {
  configured: true,
  triggers: ["events", "move", "risk"],
  available: ["fills", "move", "risk", "events"],
  move_percent: "2.0",
  risk_percent: "10.0",
  price_levels: [],
  move_levels: [],
};

function mount(body: AlertSettings) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true, data: init?.body ? JSON.parse(String(init.body)).echo ?? body : body }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AlertsPanel />
    </QueryClientProvider>,
  );
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("AlertsPanel", () => {
  it("leaves entries and exits off on the common channel and lets them be turned on", async () => {
    const fetchMock = mount(settings(shared));
    const common = await screen.findByRole("group", { name: "Common channel" });
    const fills = common.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(fills).not.toBeChecked();
    expect(screen.getByRole("group", { name: "Your chat" }).querySelector("input")).toBeChecked();

    fireEvent.click(fills);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, request] = fetchMock.mock.calls[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({
      channel: "common",
      triggers: expect.arrayContaining(["fills", "move", "risk", "events"]),
    });
  });

  it("hides the common channel when none is configured", async () => {
    mount(settings(null));
    await screen.findByRole("group", { name: "Your chat" });
    expect(screen.queryByRole("group", { name: "Common channel" })).not.toBeInTheDocument();
  });
});
