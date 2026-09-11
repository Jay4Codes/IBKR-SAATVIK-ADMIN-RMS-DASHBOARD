import Dashboard from "@/components/dashboard";
import { requireSession } from "@/lib/session";
export default async function Page({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  const { accountId } = await params;
  await requireSession(`/accounts/${encodeURIComponent(accountId)}`);
  return <Dashboard accountId={accountId} />;
}
