"use client";
import { useMutation } from "@tanstack/react-query";
import { authApi } from "@/client/api/auth.api";
export const useSignup = () => useMutation({ mutationFn: authApi.signup });

export const useGoogleSignup = () =>
  useMutation({ mutationFn: authApi.prepareGoogle });

export const useVerifySignup = () =>
  useMutation({ mutationFn: authApi.verify });
