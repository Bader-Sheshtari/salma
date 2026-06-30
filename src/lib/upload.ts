"use client";

import { createClient } from "@/lib/supabase/client";

const BUCKET = "media";

export type UploadedFile = { url: string; storage_path: string };

/** Build a collision-resistant object path inside the media bucket. */
function objectPath(file: File): string {
  const dot = file.name.lastIndexOf(".");
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  const id = crypto.randomUUID();
  const now = new Date();
  const folder = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}`;
  return ext ? `${folder}/${id}.${ext}` : `${folder}/${id}`;
}

/**
 * Upload a single file to the public `media` bucket using the browser client
 * (the admin's session cookie authorizes the write via storage RLS) and return
 * its public URL plus storage path.
 */
export async function uploadToMedia(file: File): Promise<UploadedFile> {
  const supabase = createClient();
  const path = objectPath(file);

  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    cacheControl: "3600",
    upsert: false,
    contentType: file.type || undefined,
  });
  if (error) throw new Error(error.message);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return { url: data.publicUrl, storage_path: path };
}
