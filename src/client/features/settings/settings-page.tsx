"use client";
import { useState } from "react";
import { useWorkspaces } from "@/client/queries/workspaces.queries";
import { useBusinessSettings } from "@/client/queries/settings.queries";
import { QueryBoundary } from "@/client/components/common/query-boundary";
import { PageHeader } from "@/client/components/common/page-header";
import type { Workspace } from "@/client/api/workspaces.api";
export function SettingsPage() {
  const businesses = useWorkspaces();
  return (
    <>
      <PageHeader
        title="Settings"
        description="General business settings. Local migration preview, existing Cetld is unchanged."
      />
      <QueryBoundary query={businesses}>
        {(rows) => <SettingsBusiness businesses={rows} />}
      </QueryBoundary>
    </>
  );
}
function SettingsBusiness({ businesses }: { businesses: Workspace[] }) {
  const [selected, setSelected] = useState(""),
    workspaceId = selected || businesses[0]?.id || "",
    settings = useBusinessSettings(workspaceId);
  return (
    <div className="max-w-2xl space-y-6">
      <label className="flex flex-wrap items-center gap-3">
        Business
        <select
          className="min-w-0 max-w-full rounded border p-2"
          value={workspaceId}
          onChange={(e) => setSelected(e.target.value)}
        >
          {businesses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </label>
      <QueryBoundary query={settings}>
        {(view) => (
          <>
            <section
              className="space-y-4 rounded border bg-white p-5"
              aria-label="General business settings"
            >
              <h2 className="text-lg font-semibold">Business</h2>
              {view.settings ? (
                <dl className="space-y-3">
                  <div>
                    <dt className="text-sm text-slate-600">Business name</dt>
                    <dd className="break-words">
                      {view.settings.businessName ?? "Not set"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm text-slate-600">Default currency</dt>
                    <dd>{view.settings.defaultCurrency}</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-slate-600">Default timezone</dt>
                    <dd className="break-words">
                      {view.settings.defaultTimezone}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p>
                  No saved general settings. Nothing was created by viewing this
                  page.
                </p>
              )}
            </section>
            <section
              className="space-y-4 rounded border bg-white p-5"
              aria-label="AI model settings"
            >
              <h2 className="text-lg font-semibold">AI models</h2>
              {view.aiSettings ? (
                <dl className="space-y-3">
                  <div>
                    <dt className="text-sm text-slate-600">Primary model</dt>
                    <dd className="break-words">
                      {view.aiSettings.primaryModel}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm text-slate-600">Fallback model</dt>
                    <dd className="break-words">
                      {view.aiSettings.fallbackModel ?? "None"}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p>No saved AI model settings.</p>
              )}
            </section>
            <p className="text-sm text-slate-600">
              Read-only preview. Owner verification, reminder preferences and
              integrations are not exposed here. Editing is not available in
              this migration preview.
            </p>
          </>
        )}
      </QueryBoundary>
    </div>
  );
}
