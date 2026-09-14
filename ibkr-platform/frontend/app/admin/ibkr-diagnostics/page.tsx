import Dashboard from "@/components/dashboard";
import { requireTenantAdmin } from "@/lib/session";
export default async function Page() {
  await requireTenantAdmin("/admin/ibkr-diagnostics");
  return <Dashboard diagnostics />;
}
