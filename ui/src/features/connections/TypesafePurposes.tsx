import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TYPESAFE_PURPOSES, type ToolConnection } from "@paperclipai/shared";
import { toolsApi } from "@/api/tools";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { InlineBanner } from "@/components/InlineBanner";

export function isTypesafeConnection(connection: ToolConnection): boolean {
  // Only the agent-facing TypeSafe tool connector owns per-connection purposes.
  // A direct TypeSafe Decision connection (connectionPurpose "ai") is governed
  // by the company-level purposes in Decision model settings, so its Permissions
  // page must not offer a second, conflicting set of switches.
  return connection.config?.sourceTemplateKey === "typesafe"
    && connection.connectionPurpose !== "ai"
    && connection.transport === "rest_api";
}

function readMethodConfig(connection: ToolConnection): Record<string, unknown> {
  const value = connection.config?.methodConfig;
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

/**
 * The list of named purposes Jev may serve on this connection, each with a
 * switch. Turning a purpose off makes a call that names it fail with 403
 * `typesafe_purpose_disabled`, and the purpose is no longer advertised to
 * agents through the assigned-resource context.
 */
export function TypesafePurposesSettings({
  connection,
  canConfigure,
  heading = "Where agents may use Jev",
}: {
  connection: ToolConnection;
  canConfigure: boolean;
  heading?: string;
}) {
  const client = useQueryClient();
  const saved = readMethodConfig(connection);
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const value = draft ?? saved;
  const mutation = useMutation({
    mutationFn: () =>
      toolsApi.updateConnection(connection.id, {
        config: { ...(connection.config ?? {}), methodConfig: value },
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["tools"] });
      setDraft(null);
    },
  });
  const enabledCount = TYPESAFE_PURPOSES.filter((purpose) => value[purpose.fieldKey] === true).length;
  const dirty = JSON.stringify(value) !== JSON.stringify(saved);
  return (
    <section className="space-y-3" aria-label="Jev purposes">
      <h3 className="text-sm font-medium">{heading}</h3>
      <p className="text-sm text-muted-foreground">
        Turn a purpose off to refuse it: a call that names a disabled purpose fails with 403
        and agents are not told the purpose is available.
      </p>
      <div className="space-y-3">
        {TYPESAFE_PURPOSES.map((purpose) => {
          const id = `typesafe-purpose-${purpose.id}`;
          const checked = value[purpose.fieldKey] === true;
          return (
            <div key={purpose.id} className="flex items-start justify-between gap-4">
              <div className="space-y-0.5">
                <label htmlFor={id} className="text-sm">
                  {purpose.label}
                </label>
                <p className="text-xs text-muted-foreground">{purpose.description}</p>
              </div>
              <ToggleSwitch
                id={id}
                checked={checked}
                disabled={!canConfigure || mutation.isPending}
                onCheckedChange={(next) => setDraft({ ...value, [purpose.fieldKey]: next })}
              />
            </div>
          );
        })}
      </div>
      {mutation.isError && (
        <div role="alert">
          <InlineBanner tone="danger">
            {mutation.error instanceof Error ? mutation.error.message : "Couldn’t save purposes. Try again."}
          </InlineBanner>
        </div>
      )}
      {dirty && (
        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            disabled={mutation.isPending}
            onClick={() => {
              setDraft(null);
              mutation.reset();
            }}
          >
            Cancel
          </Button>
          <Button disabled={!canConfigure || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? "Saving…" : `Save purposes (${enabledCount} on)`}
          </Button>
        </div>
      )}
    </section>
  );
}

/**
 * Company Settings mirror: edits the same per-connection purposes for every
 * TypeSafe connection in the company. Renders nothing when none exist yet.
 */
export function TypesafePurposesCompanySection({ companyId }: { companyId: string }) {
  const query = useQuery({
    queryKey: queryKeys.tools.connections(companyId),
    queryFn: () => toolsApi.listConnections(companyId),
  });
  const connections = (query.data?.connections ?? []).filter(isTypesafeConnection);
  if (query.isLoading || !connections.length) return null;
  return (
    <div className="max-w-2xl space-y-4" data-testid="company-settings-typesafe-section">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Jev purposes
      </div>
      {connections.map((connection) => (
        <div key={connection.id} className="space-y-3 rounded-lg border border-border p-4">
          <TypesafePurposesSettings connection={connection} canConfigure heading={connection.name} />
        </div>
      ))}
    </div>
  );
}
