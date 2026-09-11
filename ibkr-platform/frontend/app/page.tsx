import { redirect } from "next/navigation";
import { sessionPrincipal } from "@/lib/session";
export default async function Home() {
  redirect((await sessionPrincipal()) ? "/dashboard" : "/login");
}
