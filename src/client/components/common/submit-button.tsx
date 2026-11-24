import { Button } from "../ui/button";
export function SubmitButton({
  pending,
  children,
}: {
  pending: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button type="submit" disabled={pending} aria-busy={pending}>
      {pending ? (
        <>
          <span
            className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"
            aria-hidden
          />
          Saving...
        </>
      ) : (
        children
      )}
    </Button>
  );
}
