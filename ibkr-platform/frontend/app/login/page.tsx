import LoginForm from "@/components/login-form";
import { safeNext, sessionPrincipal } from "@/lib/session";
import { redirect } from "next/navigation";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeNext((await searchParams).next);
  if (await sessionPrincipal()) redirect(next);
  return <LoginForm next={next} />;
}
