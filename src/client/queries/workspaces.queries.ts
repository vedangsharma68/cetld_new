"use client";
import { useQuery } from "@tanstack/react-query";
import { workspacesApi } from "@/client/api/workspaces.api";
import { qk } from "./query-keys";
export const useWorkspaces = () =>
  useQuery({ queryKey: qk.workspaces.all, queryFn: workspacesApi.list });
