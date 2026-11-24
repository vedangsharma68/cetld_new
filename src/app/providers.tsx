"use client";
import { useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionProvider } from "next-auth/react";
import { Toaster } from "sonner";
import { createQueryClient } from "@/client/lib/query-client";
export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(createQueryClient);
  return (
    <SessionProvider>
      <QueryClientProvider client={client}>
        {children}
        <Toaster richColors />
      </QueryClientProvider>
    </SessionProvider>
  );
}
