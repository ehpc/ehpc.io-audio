import { mixIdValid, stemMixError, type StemMix } from "~/lib/stemMix";

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface StemManifestEntry {
  label: string;
  /** Visible name for the output; the mix name for mix ids, absent in historical payloads. */
  display_name?: string;
  filename: string;
  download_name: string;
  size_bytes: number;
  duration_s: number;
}

export interface SeparationOptions {
  extract_vocals: boolean;
  extract_instruments: boolean;
  extract_lyrics: boolean;
  detect_pitch: boolean;
  extract_pitched_lyrics: boolean;
  mixes: StemMix[];
  decrowd: boolean;
  decrowd_vocals: boolean;
  dereverb: boolean;
  genders: boolean;
  lead_backing: boolean;
  drums: boolean;
  pitch_semitones: number;
  tempo_percent: number;
}
export interface TranscriptSegmentDTO {
  start_s: number;
  end_s: number;
  text: string;
}

export type TranscriptSectionLabel =
  | "intro"
  | "verse"
  | "chorus"
  | "bridge"
  | "inst"
  | "outro"
  | "silence"
  | "pre-chorus";

export interface TranscriptSectionDTO {
  start_s: number;
  end_s: number;
  label: TranscriptSectionLabel;
}

export interface TranscriptDTO {
  status: "recognized" | "empty";
  language: string | null;
  timestamp_reference: "original";
  segments: TranscriptSegmentDTO[];
  sections: TranscriptSectionDTO[];
  structure_model: string | null;
  words?: AlignedWordDTO[];
  reference?: ReferenceReviewDTO | null;
  asr_model?: string | null;
  word_alignment?: string | null;
  recognition_chunks?: RecognitionChunkDTO[];
  untimed?: UntimedRecognitionDTO[];
  asr_extras?: TranscriptSegmentDTO[];
  canonical_word_positions?: CanonicalWordPositionDTO[];
  original_timestamped_text?: string | null;
  timestamped_text: string;
}

export interface CanonicalWordPositionDTO {
  word_index: number;
  reference_line_index: number;
  reference_token_index: number;
}

export interface PitchedLyricsTrackDTO {
  label: string;
  text: string;
  /** Unique two-column codepoints from the server's shared Unicode width rules. */
  wide_characters: string;
}

export interface AlignedWordDTO {
  start_s: number;
  end_s: number;
  text: string;
  probability: number | null;
  alignment_score?: number | null;
  origin?: "asr" | "reference-aligned" | "asr-extra";
}

export interface PitchNoteDTO {
  start_s: number;
  end_s: number;
  midi: number;
  frequency_hz: number;
  confidence: number;
  note: string;
  cents: number;
  word_indices: number[];
}

export interface PitchTrackDTO {
  label: string;
  notes: PitchNoteDTO[];
}

export interface PitchAnalysisDTO {
  version: number;
  model: string;
  source_duration_s: number;
  duration_s: number;
  pitch_shift_semitones: number;
  tempo_percent: number;
  timestamp_reference: "output";
  pitch_reference: "output";
  word_alignment: string | null;
  tracks: PitchTrackDTO[];
  words: AlignedWordDTO[];
}

export interface ReferenceCorrectionDTO {
  word_index: number;
  original: string;
  replacement: string;
  start_s: number;
  end_s: number;
}

export interface RecognitionChunkDTO {
  input_start_s: number;
  input_end_s: number;
  ownership_start_s: number;
  ownership_end_s: number;
  text: string;
  language: string;
}

export interface UntimedRecognitionDTO {
  text: string;
  reason: string;
}

export interface ReferenceLineDTO {
  text: string;
  status: "aligned" | "unconfirmed";
  support: number;
  start_s: number | null;
  end_s: number | null;
  reason: string;
  unconfirmed_words: string[];
  recognized_variant: string | null;
  group?: number;
  canonical_log_score?: number | null;
  alternative_log_score?: number | null;
  acoustic_margin?: number | null;
  acoustic_log_odds?: number | null;
  acoustic_alternative?: string | null;
  context_start_s?: number | null;
  context_end_s?: number | null;
  provider_start_s?: number | null;
  provider_end_s?: number | null;
}

export interface ReferenceReviewDTO {
  status: "skipped" | "unavailable" | "not_found" | "rejected" | "matched" | "aligned" | "partial" | "unconfirmed" | "compared" | "corrected";
  reason: string;
  provider: string;
  source_url: string | null;
  record_id: number | null;
  artist: string | null;
  title: string | null;
  album: string | null;
  duration_s: number | null;
  agreement: number | null;
  corrections: ReferenceCorrectionDTO[];
  original_segments: TranscriptSegmentDTO[];
  original_words: AlignedWordDTO[];
  fetched_at?: string | null;
  cached?: boolean;
  alignment_model?: string | null;
  lines?: ReferenceLineDTO[];
  original_untimed?: UntimedRecognitionDTO[];
  provider_timing_status?: "absent" | "candidate" | "validated" | "rejected";
  provider_timing_reason?: string | null;
  synced_lyrics_sha256?: string | null;
}

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
  transcript: TranscriptDTO | null;
  /** Absent in historical API payloads predating vocal pitch analysis. */
  pitch?: PitchAnalysisDTO | null;
  pitched_lyrics?: PitchedLyricsTrackDTO[] | null;
  /** Actual persisted full-vocal reference availability. */
  has_pitch_vocals: boolean;
  error_message: string | null;
  created_at: number;
  has_original: boolean;
}

export type BooleanOptionKey = {
  [K in keyof SeparationOptions]: SeparationOptions[K] extends boolean ? K : never;
}[keyof SeparationOptions];


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

export interface SongMatch {
  title: string;
  artists: string[];
  url: string;
  duration_seconds: number | null;
  thumbnail_url: string | null;
  play_count: number | null;
  play_count_approximate: boolean;
}

type SongSearchStatus = { status: "pending" } | { status: "done"; songs: SongMatch[] };

const API_BASE = "/api";

export interface AuthInvite {
  id: string;
  code: string | null;
  status: "pending" | "activated" | "revoked";
  recipient_email: string | null;
  activated_at: number | null;
  created_at: number;
}

export interface AdminUser {
  id: string;
  email: string;
  is_admin: boolean;
  invite_limit: number;
  disabled: boolean;
}

export interface AuthProfile extends Omit<AdminUser, "disabled"> {
  invites: AuthInvite[];
}

export class AuthHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "AuthHttpError";
  }
}

const authEvents = new EventTarget();

export function onUnauthorized(listener: () => void): () => void {
  authEvents.addEventListener("unauthorized", listener);
  return () => authEvents.removeEventListener("unauthorized", listener);
}

async function authRequest<T>(path: string, init: RequestInit = {}, isPublic = false): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { ...init, credentials: "include" });
  if (!response.ok) throw await responseError(response, !isPublic);
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

function jsonRequest(method: string, body: object): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export function authStart(email: string, inviteCode?: string): Promise<{ message: string }> {
  return authRequest("/auth/start", jsonRequest("POST", { email, invite_code: inviteCode }), true);
}

export function authVerify(email: string, code: string, inviteCode?: string): Promise<{ email: string }> {
  return authRequest("/auth/verify", jsonRequest("POST", { email, code, invite_code: inviteCode }), true);
}

export function authMe(): Promise<AuthProfile> {
  return authRequest("/auth/me");
}

export function createInvite(): Promise<{ id: string; code: string }> {
  return authRequest("/auth/invites", { method: "POST" });
}

export function deleteInvite(id: string): Promise<void> {
  return authRequest(`/auth/invites/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function authLogout(): Promise<void> {
  return authRequest("/auth/logout", { method: "POST" });
}

export function authActivity(): Promise<void> {
  return authRequest("/auth/activity", { method: "POST" });
}

export function adminUsers(): Promise<AdminUser[]> {
  return authRequest("/admin/users");
}

export function updateAdminUser(id: string, update: { invite_limit?: number; disabled?: boolean }): Promise<AdminUser> {
  return authRequest(`/admin/users/${encodeURIComponent(id)}`, jsonRequest("PATCH", update));
}

export function revokeUserSessions(id: string): Promise<void> {
  return authRequest(`/admin/users/${encodeURIComponent(id)}/revoke-sessions`, { method: "POST" });
}

const OPTION_KEYS: BooleanOptionKey[] = [
  "extract_vocals",
  "extract_instruments",
  "decrowd",
  "decrowd_vocals",
  "dereverb",
  "genders",
  "lead_backing",
  "drums",
  "extract_lyrics",
  "detect_pitch",
  "extract_pitched_lyrics",
];
function isTerminal(status: JobStatus): boolean {
  return status === "done" || status === "failed";
}

async function responseError(res: Response, notify = true): Promise<AuthHttpError> {
  if (notify && res.status === 401) authEvents.dispatchEvent(new Event("unauthorized"));
  let message = `Request failed with status ${res.status}`;
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body?.detail === "string" && body.detail) message = body.detail;
  } catch {
    // Keep the generic message for non-JSON responses.
  }
  return new AuthHttpError(res.status, message);
}

export function audioSettingsError(options: SeparationOptions): string | null {
  if (!Number.isFinite(options.pitch_semitones)) {
    return "Pitch shift must be a finite number.";
  }
  if (!Number.isFinite(options.tempo_percent) || options.tempo_percent <= 0) {
    return "Tempo must be a positive, finite number.";
  }
  for (const mix of options.mixes) {
    const mixError = stemMixError(mix);
    if (mixError) return mixError;
    if (!mixIdValid(mix.id)) return "A mix has an invalid identifier.";
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
  form.append("mixes", JSON.stringify(input.options.mixes));

  const res = await fetch(`${API_BASE}/jobs`, {
    method: "POST",
    body: form,
    credentials: "include",
  });
  if (!res.ok) {
    throw await responseError(res);
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
  if (!res.ok) throw await responseError(res);
  return (await res.json()) as KeyAnalysis;
}

/** Cancellation stops this browser's polling, not the remote model invocation. */
export async function searchSong(query: string, signal: AbortSignal): Promise<SongMatch[]> {
  const response = await fetch(`${API_BASE}/song-search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: query.trim().replace(/\s+/gu, " ") }),
    credentials: "include",
    signal,
  });
  if (!response.ok) throw await responseError(response);
  const { search_id } = await response.json() as { search_id: string; status: "pending" };
  while (true) {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, 2000);
      signal.addEventListener("abort", abort, { once: true });
    });
    signal.throwIfAborted();
    const poll = await fetch(`${API_BASE}/song-search/${encodeURIComponent(search_id)}`, {
      credentials: "include",
      signal,
    });
    if (!poll.ok) throw await responseError(poll);
    const result = await poll.json() as SongSearchStatus;
    if (result.status === "done") return result.songs;
  }
}

export async function getCurrentJob(): Promise<JobDTO | null> {
  const res = await fetch(`${API_BASE}/jobs/current`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw await responseError(res);
  }
  return (await res.json()) as JobDTO | null;
}

export async function getJob(id: number): Promise<JobDTO> {
  const res = await fetch(`${API_BASE}/jobs/${id}`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw await responseError(res);
  }
  return (await res.json()) as JobDTO;
}

export async function retryJob(id: number): Promise<SubmitResult> {
  const res = await fetch(`${API_BASE}/jobs/${id}/retry`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    throw await responseError(res);
  }
  return (await res.json()) as SubmitResult;
}

export async function listJobs(): Promise<JobDTO[]> {
  const res = await fetch(`${API_BASE}/jobs`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw await responseError(res);
  }
  return (await res.json()) as JobDTO[];
}

export async function getStatus(): Promise<StatusDTO> {
  const res = await fetch(`${API_BASE}/status`, { credentials: "include" });
  if (!res.ok) {
    throw await responseError(res);
  }
  return (await res.json()) as StatusDTO;
}

export function lyricsUrl(id: number): string {
  return `${API_BASE}/jobs/${id}/lyrics`;
}

export function lyricsDownloadUrl(id: number): string {
  return `${lyricsUrl(id)}/download`;
}

export function lyricsJsonDownloadUrl(id: number): string {
  return `${lyricsUrl(id)}/download.json`;
}

export function pitchDownloadUrl(id: number): string {
  return `${API_BASE}/jobs/${id}/pitch`;
}

export function pitchVocalsUrl(id: number): string {
  return `${API_BASE}/jobs/${id}/pitch-reference/vocals`;
}

export async function recoverPitchVocals(id: number): Promise<void> {
  const response = await fetch(pitchVocalsUrl(id), { method: "POST", credentials: "include" });
  if (!response.ok) throw await responseError(response);
}

export function pitchedLyricsDownloadUrl(id: number, label: string, format: "txt" | "odt" = "txt"): string {
  return `${API_BASE}/jobs/${id}/pitched-lyrics/${encodeURIComponent(label)}/download${format === "odt" ? "?format=odt" : ""}`;
}

export function resultUrl(id: number, label: string): string {
  return `${API_BASE}/jobs/${id}/results/${encodeURIComponent(label)}`;
}


export function originalUrl(id: number): string {
  return `${API_BASE}/jobs/${id}/original`;
}

export function playbackUrl(audioUrl: string): string {
  return `${audioUrl}?playback=1`;
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
    // EventSource exposes no HTTP status. Probe the session rather than treating
    // every network/stream error as an expired login.
    void authMe().catch(() => {});
    onError?.();
  };

  return close;
}
