"use client";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, Check, ChevronDown, ShieldAlert } from "lucide-react";
import { api } from "@/lib/api";
import { Tenant, User } from "@/lib/types";

type TenantList = { active: Tenant | null; tenants: Tenant[] };

export function TenantSwitcher({ user }: { user?: User }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const active = user?.tenant;
  const tenants = user?.tenants ?? [];
  const [all, setAll] = useState<Tenant[] | null>(null);
  const choices = all ?? tenants;

  async function load() {
    if (!user?.is_super_admin || all) return;
    try {
      setAll((await api<TenantList>("/tenants")).tenants);
    } catch {
      setAll(tenants);
    }
  }

  async function choose(tenant: Tenant) {
    if (tenant.tenant_id === active?.tenant_id) {
      setOpen(false);
      return;
    }
    setBusy(tenant.tenant_id);
    setError(null);
    try {
      await api("/tenants/switch", { tenant: tenant.tenant_id });
      client.clear();
      setOpen(false);
      window.location.reload();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Switch failed");
    } finally {
      setBusy(null);
    }
  }

  if (!user) return null;
  if (choices.length <= 1 && !user.is_super_admin) {
    return (
      <span className="tenant-chip" title="Your organisation">
        <Building2 size={13} aria-hidden="true" />
        {active?.name ?? "No tenant"}
      </span>
    );
  }

  return (
    <div className="tenant-switcher" ref={container}>
      <button
        type="button"
        className="tenant-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          void load();
        }}
      >
        <Building2 size={13} aria-hidden="true" />
        <span className="tenant-name">{active?.name ?? "Select tenant"}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {user.impersonating && (
        <span className="tenant-impersonating" title="Acting as platform administrator">
          <ShieldAlert size={12} aria-hidden="true" /> ADMIN VIEW
        </span>
      )}
      {open && (
        <div className="tenant-menu" role="listbox" aria-label="Switch tenant">
          <p className="tenant-menu-label">Organisations</p>
          {choices.map((tenant) => (
            <button
              key={tenant.tenant_id}
              type="button"
              role="option"
              aria-selected={tenant.tenant_id === active?.tenant_id}
              className={tenant.tenant_id === active?.tenant_id ? "active" : ""}
              disabled={!!busy}
              onClick={() => void choose(tenant)}
            >
              <span className="tenant-menu-mark">
                {tenant.tenant_id === active?.tenant_id && <Check size={13} />}
              </span>
              <span className="tenant-menu-body">
                <strong>{tenant.name}</strong>
                <small>
                  {tenant.slug} · {tenant.role.toLowerCase()}
                  {tenant.member === false ? " · not a member" : ""}
                </small>
              </span>
              {tenant.status !== "ACTIVE" && (
                <span className="badge warn">{tenant.status}</span>
              )}
            </button>
          ))}
          {error && (
            <p role="alert" className="tenant-menu-error">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
