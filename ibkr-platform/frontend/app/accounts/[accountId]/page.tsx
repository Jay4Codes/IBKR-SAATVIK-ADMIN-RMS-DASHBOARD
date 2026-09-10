import Dashboard from "@/components/dashboard";
export default async function Page({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  const { accountId } = await params;
  return <Dashboard accountId={accountId} />;
}
