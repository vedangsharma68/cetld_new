import { CustomerDetail } from "@/client/features/customers/customer-detail";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <CustomerDetail id={id} />;
}
