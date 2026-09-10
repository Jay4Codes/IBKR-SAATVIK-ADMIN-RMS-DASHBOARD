import Dashboard from "@/components/dashboard";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  return <Dashboard key={view} initialView={view} />;
}
