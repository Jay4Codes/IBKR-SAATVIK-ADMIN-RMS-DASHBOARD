import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { Connections } from "@/components/connections";
import { Members } from "@/components/members";
import { Connection, Member, Tenant, User } from "@/lib/types";

const apiMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock, apiDelete: deleteMock }));

function wrap(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}

const tenant = (overrides: Partial<Tenant> = {}): Tenant => ({
  tenant_id: "t1",
  slug: "sattvic",
  name: "Sattvic Wealth",
  status: "ACTIVE",
  role: "OWNER",
  accounts: [],
  ...overrides,
});

const user = (overrides: Partial<User> = {}): User => ({
  id: "u1",
  email: "admin@sattvic.test",
  role: "ADMIN",
  is_super_admin: false,
  accounts: [],
  tenant: tenant(),
  tenants: [tenant()],
  impersonating: false,
  ...overrides,
});

const connection = (overrides: Partial<Connection> = {}): Connection => ({
  id: "c1",
  tenant_id: "t1",
  name: "Primary IB Gateway",
  provider: "ibkr_gateway",
  status: "ENABLED",
  managed: true,
  host: "127.0.0.1",
  api_port: 4101,
  client_id: 17,
  trading_mode: "live",
  ibkr_username: "apibot",
  account_filter: "",
  service_unit: "ibkr-gateway@c1.service",
  ibc_config_path: "/opt/ibc/instances/c1/config.ini",
  snaptrade_user_id: null,
  snaptrade_authorized: false,
  ...overrides,
});

beforeEach(() => {
  apiMock.mockReset();
  deleteMock.mockReset();
  apiMock.mockResolvedValue({});
});

describe("tenant switcher", () => {
  it("shows a plain chip when there is only one organisation to be in", () => {
    wrap(<TenantSwitcher user={user()} />);
    expect(screen.getByText("Sattvic Wealth")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("lists every membership and marks the active one", () => {
    const second = tenant({ tenant_id: "t2", slug: "acme", name: "Acme Capital", role: "ADMIN" });
    wrap(<TenantSwitcher user={user({ tenants: [tenant(), second] })} />);
    fireEvent.click(screen.getByRole("button", { name: /Sattvic Wealth/ }));
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    expect(options[1].getAttribute("aria-selected")).toBe("false");
    expect(screen.getByText(/acme · admin/)).toBeTruthy();
  });

  it("switches through the API rather than assuming the change locally", async () => {
    // The switcher reloads so nothing from the previous tenant survives; jsdom
    // has no navigation, so stub it rather than let it warn.
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });
    const second = tenant({ tenant_id: "t2", slug: "acme", name: "Acme Capital" });
    wrap(<TenantSwitcher user={user({ tenants: [tenant(), second] })} />);
    fireEvent.click(screen.getByRole("button", { name: /Sattvic Wealth/ }));
    fireEvent.click(screen.getByRole("option", { name: /Acme Capital/ }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/tenants/switch", { tenant: "t2" }),
    );
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it("warns when a platform admin is acting inside someone else's tenant", () => {
    wrap(
      <TenantSwitcher
        user={user({ is_super_admin: true, impersonating: true, tenants: [] })}
      />,
    );
    expect(screen.getByText("ADMIN VIEW")).toBeTruthy();
  });
});

describe("broker connections", () => {
  it("shows what a gateway connection actually points at", async () => {
    apiMock.mockResolvedValue([connection()]);
    wrap(<Connections />);
    expect(await screen.findByText("Primary IB Gateway")).toBeTruthy();
    expect(screen.getByText("127.0.0.1:4101")).toBeTruthy();
    expect(screen.getByText(/ibkr-gateway@c1.service/)).toBeTruthy();
    expect(screen.getByText(/apibot/)).toBeTruthy();
  });

  it("marks an adopted connection so nobody expects us to manage its files", async () => {
    apiMock.mockResolvedValue([connection({ managed: false })]);
    wrap(<Connections />);
    expect(await screen.findByText("ADOPTED")).toBeTruthy();
  });

  it("offers the SnapTrade link flow instead of gateway controls", async () => {
    apiMock.mockResolvedValue([
      connection({
        provider: "snaptrade",
        snaptrade_user_id: "t1:c1",
        ibkr_username: null,
      }),
    ]);
    wrap(<Connections />);
    expect(await screen.findByText("Get connection link")).toBeTruthy();
    expect(screen.queryByText("Start gateway")).toBeNull();
    expect(screen.getByText("awaiting the client")).toBeTruthy();
  });

  it("creates a gateway connection with the chosen options", async () => {
    // Routed by path: the list refetch that follows the create must still get a
    // list, not the newly created row.
    apiMock.mockImplementation((path: string, body?: unknown) =>
      path === "/connections" && body !== undefined
        ? Promise.resolve(connection({ id: "c2", api_port: 4102 }))
        : Promise.resolve([]),
    );
    wrap(<Connections />);
    fireEvent.click(await screen.findByText("Add connection"));
    fireEvent.change(screen.getByLabelText(/Connection name/), {
      target: { value: "Acme production" },
    });
    fireEvent.change(screen.getByLabelText(/Trading mode/), {
      target: { value: "live" },
    });
    fireEvent.click(screen.getByText(/Create IB Gateway connection/));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/connections",
        expect.objectContaining({
          name: "Acme production",
          provider: "ibkr_gateway",
          trading_mode: "live",
          read_only_login: true,
        }),
      ),
    );
    expect(
      await screen.findByText(/Provisioned on port 4102/),
    ).toBeTruthy();
  });

  it("offers the SnapTrade path without gateway-only fields", async () => {
    apiMock.mockResolvedValue([]);
    wrap(<Connections />);
    fireEvent.click(await screen.findByText("Add connection"));
    expect(screen.getByLabelText(/Trading mode/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /SnapTrade/ }));
    expect(screen.queryByLabelText(/Trading mode/)).toBeNull();
    expect(screen.queryByLabelText(/Read-only login/)).toBeNull();
    expect(screen.getByText(/Create SnapTrade connection/)).toBeTruthy();
  });

  it("explains what removing an adopted connection does and does not delete", async () => {
    apiMock.mockResolvedValue([connection({ managed: false })]);
    wrap(<Connections />);
    fireEvent.click(await screen.findByText("Remove"));
    expect(
      screen.getByText(/left exactly where they are/),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Remove it"));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("/connections/c1"));
  });
});

describe("members", () => {
  const members: Member[] = [
    {
      user_id: "u1",
      email: "admin@sattvic.test",
      role: "OWNER",
      accounts: [],
      is_super_admin: false,
    },
    {
      user_id: "u2",
      email: "desk@sattvic.test",
      role: "TRADER",
      accounts: ["DU1"],
      is_super_admin: false,
    },
  ];

  it("distinguishes tenant-wide access from an explicit account grant", async () => {
    apiMock.mockResolvedValue(members);
    wrap(<Members user={user()} />);
    expect(await screen.findByText("all in tenant")).toBeTruthy();
    expect(screen.getByText("DU1")).toBeTruthy();
  });

  it("refuses to let an admin remove their own access", async () => {
    apiMock.mockResolvedValue(members);
    wrap(<Members user={user()} />);
    const buttons = await screen.findAllByText("Remove");
    expect((buttons[0].closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect((buttons[1].closest("button") as HTMLButtonElement).disabled).toBe(false);
  });

});
