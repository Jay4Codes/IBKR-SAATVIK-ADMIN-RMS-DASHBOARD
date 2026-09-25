"use client";

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Account } from "@/lib/types";

/** "Name · U123" when the account has been named, otherwise the bare ID. */
export function accountDisplay(account: { account_id: string; label?: string | null }): string {
  const label = account.label?.trim();
  return label ? `${label} · ${account.account_id}` : account.account_id;
}

/** Resolve account IDs to "Name · ID" using the accounts list the dashboard already loads. */
export function useAccountNames() {
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<Account[]>("/accounts"),
    staleTime: 60_000,
  });
  const labels = new Map((accounts.data ?? []).map((a) => [a.account_id, a.label?.trim() || ""]));
  const name = useCallback(
    (id: string) => {
      const label = labels.get(id);
      return label ? `${label} · ${id}` : id;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts.data],
  );
  const label = useCallback((id: string) => labels.get(id) || "", [accounts.data]); // eslint-disable-line react-hooks/exhaustive-deps
  return { name, label };
}
