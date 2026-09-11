"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { BrandMark } from "@/components/brand";
import { Button } from "@/components/ui/button";
export default function LoginForm({ next = "/dashboard" }: { next?: string }) {
  const [error, setError] = useState(""),
    [pending, setPending] = useState(false);
  const router = useRouter();
  return (
    <main className="login">
      <section>
        <BrandMark priority />
        <p className="eyebrow">SATTVIC / RMS</p>
        <h1>Operations terminal</h1>
        <p className="muted">Sign in to monitor your IBKR accounts.</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setPending(true);
            setError("");
            const data = new FormData(e.currentTarget);
            try {
              await api("/auth/login", {
                email: data.get("email"),
                password: data.get("password"),
              });
              router.replace(next);
            } catch (error) {
              setError(String(error));
            } finally {
              setPending(false);
            }
          }}
        >
          <label>
            Email
            <input name="email" type="email" autoComplete="username" required />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          {error && (
            <p role="alert" className="negative">
              {error}
            </p>
          )}
          <Button disabled={pending}>
            {pending ? "Signing in…" : "Sign in →"}
          </Button>
        </form>
        <small>Authorized personnel · Read-only monitoring</small>
      </section>
    </main>
  );
}
