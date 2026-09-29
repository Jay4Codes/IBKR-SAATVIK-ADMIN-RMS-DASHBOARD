"use client";

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Account } from "@/lib/types";

export function accountDisplay(account: { account_id: string; label?: string | null }): string {
  const label = account.label?.trim();
  return label ? `${label} · ${account.account_id}` : account.account_id;
}

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
    [accounts.data],
  );
  const label = useCallback((id: string) => labels.get(id) || "", [accounts.data]);
  return { name, label };
}
