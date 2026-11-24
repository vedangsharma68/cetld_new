"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { profileApi } from "@/client/api/profile.api";
import { qk } from "./query-keys";
export function useProfile() {
  return useQuery({ queryKey: qk.profile.self, queryFn: profileApi.read });
}
export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: profileApi.update,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.profile.self });
    },
  });
}
