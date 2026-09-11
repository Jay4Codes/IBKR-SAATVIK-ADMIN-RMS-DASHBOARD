import Dashboard from "@/components/dashboard";
import { requireTenantAdmin } from "@/lib/session";
// Every request this screen makes is behind require_tenant_admin, so a
// non-admin who reaches it sees nothing but 403s. Gate the page on the
// same role rather than rendering a shell that cannot load.
export default async function Page() {
  await requireTenantAdmin("/admin/ibkr-diagnostics");
  return <Dashboard diagnostics />;
}
