"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2 } from "lucide-react";
import { api } from "@/lib/api";
import { TenantSummary } from "@/lib/types";
import { TablePager, usePagedRows } from "./table-pager";
import { Button } from "./ui/button";

export function TenantsAdmin() {
  const client = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tenants = useQuery({
    queryKey: ["admin-tenants"],
    queryFn: () => api<TenantSummary[]>("/admin/tenants"),
  });

  function done(message: string) {
    setNotice(message);
    setError(null);
    void client.invalidateQueries({ queryKey: ["admin-tenants"] });
    void client.invalidateQueries({ queryKey: ["me"] });
  }

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<TenantSummary>("/admin/tenants", body),
    onSuccess: (tenant) => done(`Created ${tenant.name} (${tenant.slug}).`),
    onError: (problem: Error) => {
      setError(problem.message);
      setNotice(null);
    },
  });

  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      api(`/admin/tenants/${id}`, body),
    onSuccess: () => done("Tenant updated."),
    onError: (problem: Error) => setError(problem.message),
  });

  const rows = tenants.data ?? [];
  const paged = usePagedRows(rows);
  if (tenants.error) return <p role="alert">{tenants.error.message}</p>;

  return (
    <>
      <section className="panel">
        <h2>
          Tenants
          <span>{rows.length} on this platform</span>
        </h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Slug</th>
                <th>Status</th>
                <th>Members</th>
                <th>Connections</th>
                <th>Accounts</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {paged.rows.map((tenant) => (
                <tr key={tenant.tenant_id}>
                  <td data-label="Name">{tenant.name}</td>
                  <td data-label="Slug">{tenant.slug}</td>
                  <td data-label="Status">
                    <span
                      className={`badge ${tenant.status === "ACTIVE" ? "positive" : "warn"}`}
                    >
                      {tenant.status}
                    </span>
                  </td>
                  <td data-label="Members">{tenant.members}</td>
                  <td data-label="Connections">{tenant.connections}</td>
                  <td data-label="Accounts">{tenant.accounts}</td>
                  <td data-label="Actions">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={update.isPending}
                      title={
                        tenant.status === "ACTIVE"
                          ? "Suspending locks every member out of this tenant"
                          : "Restore access for this tenant's members"
                      }
                      onClick={() =>
                        update.mutate({
                          id: tenant.tenant_id,
                          status:
                            tenant.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE",
                        })
                      }
                    >
                      {tenant.status === "ACTIVE" ? "Suspend" : "Reactivate"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && !tenants.isLoading && (
            <div className="empty">No tenants yet</div>
          )}
        </div>
        <TablePager page={paged.page} pages={paged.pages} total={paged.total} onPage={paged.setPage} />
      </section>

      <section className="panel">
        <h2>Onboard a client</h2>
        <form
          className="stacked-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = new FormData(form);
            const owner = String(data.get("owner_email") ?? "").trim();
            create.mutate({
              name: String(data.get("name") ?? "").trim(),
              slug: String(data.get("slug") ?? "").trim() || null,
              owner_email: owner || null,
            });
            form.reset();
          }}
        >
          <div className="field-row">
            <label>
              Organisation name
              <input name="name" required minLength={2} maxLength={80} placeholder="Acme Capital" />
            </label>
            <label>
              Slug
              <input name="slug" maxLength={40} placeholder="derived from the name" />
            </label>
            <label>
              Owner email
              <input name="owner_email" type="email" placeholder="optional — an existing login" />
            </label>
          </div>
          <div className="form-footer">
            <Button type="submit" size="sm" disabled={create.isPending}>
              <Building2 size={14} aria-hidden="true" />
              {create.isPending ? "Creating…" : "Create tenant"}
            </Button>
            <p className="muted">
              A new tenant starts empty: no accounts, no broker connection, and
              no data of its own until one is added. Naming an owner grants an
              existing login full control of it.
            </p>
          </div>
          {notice && (
            <p role="status" className="notice positive">
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className="notice negative">
              {error}
            </p>
          )}
        </form>
      </section>
    </>
  );
}
