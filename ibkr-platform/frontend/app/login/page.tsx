import LoginForm from "@/components/login-form";
import { safeNext, sessionPrincipal } from "@/lib/session";
import { redirect } from "next/navigation";

// Signing in again while already signed in just loses the page you were
// heading for, so send an authenticated visitor straight on. A cookie that
// the API no longer recognises falls through to the form instead of bouncing.
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeNext((await searchParams).next);
  if (await sessionPrincipal()) redirect(next);
  return <LoginForm next={next} />;
}
