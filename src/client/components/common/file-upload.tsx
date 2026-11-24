"use client";
import { useId, useState } from "react";
export function FileUpload({
  onFile,
  pending = false,
  progress,
}: {
  onFile: (file: File) => void;
  pending?: boolean;
  progress?: number;
}) {
  const id = useId();
  const [error, setError] = useState("");
  function accept(file: File | undefined) {
    if (!file) return;
    setError("");
    if (file.type !== "application/pdf") {
      setError("Choose a PDF file.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("Choose a file under 10 MB.");
      return;
    }
    onFile(file);
  }
  return (
    <div>
      <label
        htmlFor={id}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (!pending) accept(event.dataTransfer.files[0]);
        }}
        className="block rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center"
      >
        <span className="block font-medium">Choose a PDF or drop it here</span>
        <span className="mt-2 block text-sm text-slate-500">
          PDF only, up to 10 MB
        </span>
        <input
          id={id}
          type="file"
          accept="application/pdf"
          disabled={pending}
          onChange={(event) => accept(event.target.files?.[0])}
          className="mt-4 max-w-full"
        />
      </label>
      {progress !== undefined && (
        <progress
          value={progress}
          max={100}
          aria-label="Upload progress"
          className="mt-3 w-full"
        />
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
