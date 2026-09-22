"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserMinus } from "lucide-react";
import { api, apiDelete } from "@/lib/api";
import { Member, TenantRole, User } from "@/lib/types";
import { Button } from "./ui/button";

const SCOPED: TenantRole[] = ["TRADER", "VIEWER"];

export function Members({ user }: { user?: User }) {
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const members = useQuery({
    queryKey: ["members"],
    queryFn: () => api<Member[]>("/members"),
  });

  const remove = useMutation({
    mutationFn: (member: Member) => apiDelete(`/members/${member.user_id}`),
    onSuccess: () => {
      setRemoving(null);
      setNotice("Access removed.");
      setError(null);
      void client.invalidateQueries({ queryKey: ["members"] });
    },
    onError: (problem: Error) => {
      setRemoving(null);
      setError(problem.message);
    },
  });

  if (members.error) return <p role="alert">{members.error.message}</p>;
  const rows = members.data ?? [];

  return (
    <>
      <section className="panel">
        <h2>
          Members
          <span>
            {rows.length} with access to {user?.tenant?.name ?? "this tenant"}
          </span>
        </h2>
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
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Accounts</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((member) => (
                <tr key={member.user_id}>
                  <td data-label="Email">
                    {member.email}
                    {member.is_super_admin && (
                      <small>platform administrator</small>
                    )}
                  </td>
                  <td data-label="Role">
                    <span className="badge">{member.role}</span>
                  </td>
                  <td data-label="Accounts">
                    {SCOPED.includes(member.role)
                      ? member.accounts.join(", ") || "none granted"
                      : "all in tenant"}
                  </td>
                  <td data-label="Actions">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="danger-text"
                      disabled={member.user_id === user?.id}
                      title={
                        member.user_id === user?.id
                          ? "You cannot remove your own access"
                          : "Remove access to this tenant"
                      }
                      onClick={() => setRemoving(member)}
                    >
                      <UserMinus size={14} aria-hidden="true" /> Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && !members.isLoading && (
            <div className="empty">No members yet</div>
          )}
        </div>
      </section>

      {removing && (
        <section className="panel">
          <div className="confirm" role="alert">
            <strong>Remove {removing.email} from this tenant?</strong>
            <p className="muted">
              Their login survives and any access they hold in other tenants is
              untouched. Open sessions lose this tenant on their next request.
            </p>
            <div className="panel-actions">
              <Button
                type="button"
                size="sm"
                className="gw-primary danger"
                disabled={remove.isPending}
                onClick={() => remove.mutate(removing)}
              >
                Remove access
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setRemoving(null)}
              >
                Cancel
              </Button>
            </div>
          </div>
        </section>
      )}

    </>
  );
}
