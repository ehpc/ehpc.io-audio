export type JobStatus = "queued" | "running" | "done" | "failed";

export interface StemManifestEntry {
  label: string;
  filename: string;
  download_name: string;
  size_bytes: number;
  duration_s: number;
}

export interface SeparationOptions {
  extract_vocals: boolean;
  extract_instruments: boolean;
  mix_female_instruments: boolean;
  mix_male_instruments: boolean;
  mix_backing_instruments: boolean;
  decrowd: boolean;
  decrowd_vocals: boolean;
  dereverb: boolean;
  genders: boolean;
  lead_backing: boolean;
  drums: boolean;
  no_cache: boolean;
  pitch_semitones: number;
  tempo_percent: number;
}

export type BooleanOptionKey = {
  [K in keyof SeparationOptions]: SeparationOptions[K] extends boolean ? K : never;
}[keyof SeparationOptions];

export interface JobDTO {
  id: number;
  status: JobStatus;
  position: number | null;
  source_type: "url" | "upload";
  source_value: string;
  title: string | null;
  original_key: string | null;
  output_key: string | null;
  options: SeparationOptions;
  manifest: StemManifestEntry[] | null;
  error_message: string | null;
  created_at: number;
  has_original: boolean;
}

/** What to show a user for a job: the resolved track title, else the raw source. */
export function jobLabel(job: JobDTO): string {
  return job.title ?? job.source_value;
}


export interface SubmitResult {
  id: number;
  status: "queued";
  position: number;
}

export interface DiskUsage {
  total_bytes: number;
  used_bytes: number;
  free_bytes: number;
  results_bytes: number;
  db_bytes: number;
}

export interface RecentJob {
  id: number;
  status: JobStatus;
  title: string | null;
  source_value: string;
  created_at: number;
}

export interface StatusDTO {
  total_jobs: number;
  counts: Record<string, number>;
  queue_concurrency: number;
  disk: DiskUsage;
  recent: RecentJob[];
  modal_app: string;
}

export interface AudioSource {
  url?: string;
  file?: File;
}

export interface SubmitInput extends AudioSource {
  options: SeparationOptions;
}

export interface KeyAnalysis {
  original_key: string | null;
}

const API_BASE = "/api";

const OPTION_KEYS: BooleanOptionKey[] = [
  "extract_vocals",
  "extract_instruments",
  "mix_female_instruments",
  "mix_male_instruments",
  "mix_backing_instruments",
  "decrowd",
  "decrowd_vocals",
  "dereverb",
  "genders",
  "lead_backing",
  "drums",
  "no_cache",
];
function isTerminal(status: JobStatus): boolean {
  return status === "done" || status === "failed";
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: string };
    if (body?.detail) return body.detail;
  } catch {
    // fall through to a generic message
  }
  return `Request failed with status ${res.status}`;
}

export function audioSettingsError(options: SeparationOptions): string | null {
  if (!Number.isFinite(options.pitch_semitones)) {
    return "Pitch shift must be a finite number.";
  }
  if (!Number.isFinite(options.tempo_percent) || options.tempo_percent <= 0) {
    return "Tempo must be a positive, finite number.";
  }
  return null;
}

export async function submitJob(input: SubmitInput): Promise<SubmitResult> {
  const invalid = audioSettingsError(input.options);
  if (invalid) throw new Error(invalid);
  const form = new FormData();
  if (input.file) {
    form.append("file", input.file);
  } else if (input.url !== undefined) {
    form.append("url", input.url);
  }
  for (const key of OPTION_KEYS) {
    form.append(key, String(input.options[key]));
  }
  form.append("pitch_semitones", String(input.options.pitch_semitones));
  form.append("tempo_percent", String(input.options.tempo_percent));

  const res = await fetch(`${API_BASE}/jobs`, {
    method: "POST",
    body: form,
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(await readError(res));
  }
  return (await res.json()) as SubmitResult;
}

export async function analyzeKey(source: AudioSource, signal: AbortSignal): Promise<KeyAnalysis> {
  const form = new FormData();
  if (source.file) form.append("file", source.file);
  else if (source.url !== undefined) form.append("url", source.url);
  const res = await fetch(`${API_BASE}/key-analysis`, {
    method: "POST",
    body: form,
    credentials: "include",
    signal,
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as KeyAnalysis;
}

export async function getCurrentJob(): Promise<JobDTO | null> {
  const res = await fetch(`${API_BASE}/jobs/current`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(await readError(res));
  }
  return (await res.json()) as JobDTO | null;
}

export async function getJob(id: number): Promise<JobDTO> {
  const res = await fetch(`${API_BASE}/jobs/${id}`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(await readError(res));
  }
  return (await res.json()) as JobDTO;
}

export async function retryJob(id: number): Promise<SubmitResult> {
  const res = await fetch(`${API_BASE}/jobs/${id}/retry`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(await readError(res));
  }
  return (await res.json()) as SubmitResult;
}

export async function listJobs(): Promise<JobDTO[]> {
  const res = await fetch(`${API_BASE}/jobs`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(await readError(res));
  }
  return (await res.json()) as JobDTO[];
}

export async function getStatus(): Promise<StatusDTO> {
  const res = await fetch(`${API_BASE}/status`, { credentials: "include" });
  if (!res.ok) {
    throw new Error(await readError(res));
  }
  return (await res.json()) as StatusDTO;
}

export function resultUrl(id: number, label: string): string {
  return `${API_BASE}/jobs/${id}/results/${encodeURIComponent(label)}`;
}

export function originalUrl(id: number): string {
  return `${API_BASE}/jobs/${id}/original`;
}

export function subscribeToJob(
  id: number,
  onUpdate: (job: JobDTO) => void,
  onError?: () => void,
): () => void {
  const source = new EventSource(`${API_BASE}/jobs/${id}/events`, {
    withCredentials: true,
  });
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    source.close();
  };

  source.onmessage = (event) => {
    const job = JSON.parse(event.data) as JobDTO;
    onUpdate(job);
    // The server ends the stream after a terminal event; close proactively so a
    // reconnect is never attempted for a job that will not change again.
    if (isTerminal(job.status)) {
      close();
    }
  };

  source.onerror = () => {
    if (closed) return;
    close();
    onError?.();
  };

  return close;
}
