import Dashboard from "@/components/dashboard";
import { requireSession } from "@/lib/session";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  await requireSession("/dashboard", view ? `?view=${encodeURIComponent(view)}` : "");
  return <Dashboard key={view} initialView={view} />;
}
