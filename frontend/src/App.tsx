import { createEffect, createSignal, onCleanup, onMount, Show, type Component } from "solid-js";
import * as Dialog from "@kobalte/core/dialog";
import type { JobDTO } from "./api";
import { getCurrentJob, getJob, listJobs, retryJob, subscribeToJob } from "./api";
import SubmitForm from "./components/SubmitForm";
import QueueStatus from "./components/QueueStatus";
import JobStatusDock from "./components/JobStatusDock";
import ResultsView, { type HistoryScrollRequest } from "./components/ResultsView";
import HistoryView from "./components/HistoryView";
import { useAuth } from "./AuthProvider";
import ProfileView from "./ProfileView";
import AdminView from "./AdminView";
import { Button } from "~/components/button";

const App: Component = () => {
  const [job, setJob] = createSignal<JobDTO | null>(null);
  const [trackedJob, setTrackedJob] = createSignal<JobDTO | null>(null);
  const subscriptions = new Map<number, () => void>();
  let progressTarget: HTMLDivElement | undefined;
  const [history, setHistory] = createSignal<JobDTO[]>([]);
  const [historyScrollRequest, setHistoryScrollRequest] = createSignal<HistoryScrollRequest | null>(null);
  let historyScrollToken = 0;
  const deletedJobIds = new Set<number>();
  let currentJobRevision = 0;
  let historyRequestRevision = 0;
  const [selectedJobRefreshError, setSelectedJobRefreshError] = createSignal<string | null>(null);
  const [retryingId, setRetryingId] = createSignal<number | null>(null);
  const [retryError, setRetryError] = createSignal<{ jobId: number; message: string } | null>(null);
  const auth = useAuth();
  const [tab, setTab] = createSignal<"workspace" | "profile" | "people">("workspace");
  const [accountError, setAccountError] = createSignal("");
  const [mobileLibrary, setMobileLibrary] = createSignal(false);
  const [libraryOpen, setLibraryOpen] = createSignal(false);
  let libraryTrigger: HTMLButtonElement | undefined;
  let selectedFromLibrary = false;
  let viewingFromLibrary = false;

  onMount(() => {
    const query = window.matchMedia?.("(max-width: 1000px)");
    if (!query) return;
    const update = () => { setMobileLibrary(query.matches); if (!query.matches) setLibraryOpen(false); };
    update();
    query.addEventListener("change", update);
    onCleanup(() => query.removeEventListener("change", update));
  });

  onMount(() => {
    const pauseOtherAudio = (event: Event) => {
      const current = event.target;
      if (!(current instanceof HTMLAudioElement)) return;
      document.querySelectorAll("audio").forEach((audio) => {
        if (audio !== current && !audio.paused) audio.pause();
      });
    };
    document.addEventListener("play", pauseOtherAudio, true);
    onCleanup(() => document.removeEventListener("play", pauseOtherAudio, true));
  });

  const refreshHistory = async () => {
    const requestRevision = ++historyRequestRevision;
    try {
      const jobs = await listJobs();
      if (requestRevision !== historyRequestRevision) return;
      setHistory(jobs.filter((item) => !deletedJobIds.has(item.id)));
    } catch {
      // leave the previous list in place if this refresh fails
    }
  };

  const refreshSelectedJob = async (id: number, scrollToken?: number) => {
    const requestRevision = ++currentJobRevision;
    setSelectedJobRefreshError(null);
    try {
      const latest = await getJob(id);
      if (requestRevision !== currentJobRevision || deletedJobIds.has(id) || job()?.id !== id) return;
      setJob(latest);
      if (trackedJob()?.id === id) setTrackedJob(latest);
      historyRequestRevision++;
      setHistory(items => items.some(item => item.id === id)
        ? items.map(item => item.id === id ? latest : item)
        : [latest, ...items]);
    } catch (error) {
      if (requestRevision !== currentJobRevision || deletedJobIds.has(id) || job()?.id !== id) return;
      const detail = error instanceof Error ? ` ${error.message}` : "";
      setSelectedJobRefreshError(`Could not refresh this result.${detail} The displayed version may be stale.`);
    }
    if (scrollToken !== undefined && requestRevision === currentJobRevision && job()?.id === id) {
      setHistoryScrollRequest({ jobId: id, token: scrollToken });
    }
  };
  // One stream per active ID, shared by the selected view and the latest
  // accepted job. A late fallback is ignored once that ID is no longer watched.
  createEffect(() => {
    const selected = job();
    const tracked = trackedJob();
    const wanted = new Set<number>();
    if (selected && (selected.status === "queued" || selected.status === "running")) wanted.add(selected.id);
    if (tracked && (tracked.status === "queued" || tracked.status === "running")) wanted.add(tracked.id);
    for (const [id, unsubscribe] of subscriptions) {
      if (!wanted.has(id)) {
        subscriptions.delete(id);
        unsubscribe();
      }
    }
    for (const id of wanted) {
      if (subscriptions.has(id)) continue;
      let valid = true;
      let updateRevision = 0;
      const apply = (next: JobDTO) => {
        if (!valid || next.id !== id || deletedJobIds.has(id)) return;
        updateRevision++;
        if (job()?.id === id) {
          currentJobRevision++;
          setSelectedJobRefreshError(null);
          setJob(next);
        }
        if (trackedJob()?.id === id) setTrackedJob(next);
        if (next.status === "done" || next.status === "failed") void refreshHistory();
      };
      const close = subscribeToJob(id, apply, async () => {
        const revision = updateRevision;
        try {
          const snapshot = await getJob(id);
          if (revision === updateRevision) apply(snapshot);
        } catch { /* Keep the last known status while the stream reconnects. */ }
      });
      subscriptions.set(id, () => { valid = false; close(); });
    }
  });
  onCleanup(() => {
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
  });

  onMount(() => {
    const root = document.documentElement;
    const action = document.querySelector<HTMLElement>(".workspace-action");
    const updateAction = () => {
      const rect = action?.getBoundingClientRect();
      const sticky = action && rect && getComputedStyle(action).position === "sticky" &&
        rect.bottom >= innerHeight - 1 && rect.top < innerHeight && rect.bottom <= innerHeight + 1;
      root.style.setProperty("--job-action-height", sticky ? `${rect.height}px` : "0px");
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateAction);
    if (action) observer?.observe(action);
    window.addEventListener("scroll", updateAction, { passive: true });
    window.addEventListener("resize", updateAction);
    let focusFrame = 0;
    const updateAfterFocus = () => {
      cancelAnimationFrame(focusFrame);
      focusFrame = requestAnimationFrame(updateAction);
    };
    document.addEventListener("focusin", updateAfterFocus);
    document.addEventListener("focusout", updateAfterFocus);
    updateAction();
    createEffect(() => {
      tab();
      const frame = requestAnimationFrame(updateAction);
      onCleanup(() => cancelAnimationFrame(frame));
    });
    onCleanup(() => {
      observer?.disconnect();
      window.removeEventListener("scroll", updateAction);
      window.removeEventListener("resize", updateAction);
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("focusin", updateAfterFocus);
      document.removeEventListener("focusout", updateAfterFocus);
      root.style.removeProperty("--job-action-height");
    });
  });

  const viewTrackedJob = () => {
    const tracked = trackedJob();
    if (!tracked || deletedJobIds.has(tracked.id)) return;
    currentJobRevision++;
    setSelectedJobRefreshError(null);
    setHistoryScrollRequest(null);
    setTab("workspace");
    if (libraryOpen()) {
      viewingFromLibrary = true;
      selectedFromLibrary = false;
      setLibraryOpen(false);
    }
    setJob(tracked);
    if (tracked.status === "done" || tracked.status === "failed") void refreshSelectedJob(tracked.id);
    if (!viewingFromLibrary) {
      requestAnimationFrame(() => {
        progressTarget?.scrollIntoView({ block: "start", behavior: "auto" });
        progressTarget?.focus({ preventScroll: true });
      });
    }
  };


  onMount(async () => {
    const requestRevision = ++currentJobRevision;
    try {
      const current = await getCurrentJob();
      if (requestRevision === currentJobRevision) {
        setJob(current);
        if (current && (current.status === "queued" || current.status === "running")) setTrackedJob(current);
      }
    } catch {
      if (requestRevision === currentJobRevision) setJob(null);
    }
    void refreshHistory();
  });

  const onSubmitted = (newJob: JobDTO, select = true) => {
    if (select) {
      currentJobRevision++;
      setSelectedJobRefreshError(null);
      setLibraryOpen(false);
      setHistoryScrollRequest(null);
    }
    setTrackedJob(newJob);
    if (select) setJob(newJob);
    void refreshHistory();
  };

  const retrySelectedJob = async () => {
    const failed = job();
    if (!failed || failed.status !== "failed" || retryingId() !== null) return;
    setRetryingId(failed.id);
    setRetryError(null);
    try {
      const result = await retryJob(failed.id);
      onSubmitted({
        ...failed,
        ...result,
        original_key: null,
        output_key: null,
        result_revision: null,
        manifest: null,
        transcript: null,
        pitch: null,
        pitched_lyrics: null,
        error_message: null,
        created_at: Math.floor(Date.now() / 1000),
        has_original: false,
        has_pitch_vocals: false,
      }, job()?.id === failed.id);
    } catch (error) {
      setRetryError({ jobId: failed.id, message: error instanceof Error ? error.message : "Could not retry this job." });
    } finally {
      setRetryingId(null);
    }
  };

  const onHistorySelect = (selected: JobDTO) => {
    setHistoryScrollRequest(null);
    setSelectedJobRefreshError(null);
    if (job()?.id !== selected.id) setJob(trackedJob()?.id === selected.id ? trackedJob()! : selected);
    if (libraryOpen()) {
      selectedFromLibrary = true;
      setLibraryOpen(false);
    }
    void refreshSelectedJob(selected.id, ++historyScrollToken);
  };
  const onReset = () => {
    currentJobRevision++;
    setSelectedJobRefreshError(null);
    setHistoryScrollRequest(null);
    if (trackedJob()?.id === job()?.id && trackedJob()?.status !== "queued" && trackedJob()?.status !== "running") setTrackedJob(null);
    setJob(null);
  };


  const isActive = () => job()?.status === "queued" || job()?.status === "running";
  const isDone = () => job()?.status === "done";

  const onDeleted = (id: number) => {
    deletedJobIds.add(id);
    historyRequestRevision++;
    setHistory((items) => items.filter((item) => item.id !== id));
    if (trackedJob()?.id === id) setTrackedJob(null);
    if (job()?.id === id) {
      currentJobRevision++;
      setSelectedJobRefreshError(null);
      setHistoryScrollRequest(null);
      setJob(null);
    }
  };
  const refreshWorkspace = async () => {
    await refreshHistory();
    const current = job();
    if (current?.status === "done" && job()?.id === current.id) await refreshSelectedJob(current.id);
  };
  const selectTab = (next: "workspace" | "profile" | "people") => {
    setTab(next);
    if (next === "workspace") void refreshWorkspace();
  };
  const LibraryHistory = () => <HistoryView jobs={history()} selectedId={job()?.id} onSelect={onHistorySelect} onDeleted={onDeleted} />;

  return (
    <main class="app-shell">
      <header class="app-header">
        <h1>ehpc's Vocal Tools</h1>
        <p>Your audio workspace</p>
      </header>
      <nav class="account-nav" aria-label="Account navigation">
        <div class="account-tabs">
          <Button variant={tab() === "workspace" ? "secondary" : "ghost"} aria-pressed={tab() === "workspace"} onClick={() => selectTab("workspace")}>Workspace</Button>
          <Button variant={tab() === "profile" ? "secondary" : "ghost"} aria-pressed={tab() === "profile"} onClick={() => selectTab("profile")}>Profile</Button>
          <Show when={auth.profile().is_admin}><Button variant={tab() === "people" ? "secondary" : "ghost"} aria-pressed={tab() === "people"} onClick={() => selectTab("people")}>People</Button></Show>
        </div>
        <div class="account-actions"><span>{auth.profile().email}</span><Button variant="outline" onClick={() => { setAccountError(""); void auth.logout().catch((error) => setAccountError(error instanceof Error ? error.message : "Could not sign out.")); }}>Sign out</Button></div>
      </nav>
      <Show when={accountError()}><p role="alert" class="auth-error">{accountError()}</p></Show>
      <Show when={tab() === "profile"}><ProfileView profile={auth.profile()} refresh={auth.refresh} /></Show>
      <Show when={tab() === "people" && auth.profile().is_admin}><AdminView /></Show>
      <div hidden={tab() !== "workspace"}>
      <div class="library-workspace">
        <Show when={!mobileLibrary()}>
          <aside class="library-rail" aria-label="Library"><h2>Library</h2><LibraryHistory /></aside>
        </Show>
        <div class="library-main">
          <Show when={mobileLibrary()}>
            <Dialog.Root open={libraryOpen()} onOpenChange={setLibraryOpen}>
              <Dialog.Trigger as={Button} ref={libraryTrigger} type="button" variant="outline" class="library-trigger">Library <span aria-hidden="true">Browse ›</span></Dialog.Trigger>
              <Dialog.Portal>
                <Dialog.Overlay class="library-overlay" />
                <Dialog.Content class="library-drawer" onCloseAutoFocus={event => {
                  if (viewingFromLibrary) {
                    event.preventDefault();
                    viewingFromLibrary = false;
                    requestAnimationFrame(() => {
                      progressTarget?.scrollIntoView({ block: "start", behavior: "auto" });
                      progressTarget?.focus({ preventScroll: true });
                    });
                  } else if (selectedFromLibrary) {
                    event.preventDefault();
                    selectedFromLibrary = false;
                    libraryTrigger?.focus({ preventScroll: true });
                  }
                }}>
                  <div class="library-drawer-header"><Dialog.Title>Library</Dialog.Title><Dialog.CloseButton as={Button} type="button" variant="outline" aria-label="Close library">Close</Dialog.CloseButton></div>
                  <Dialog.Description class="sr-only">Choose a song to open its results.</Dialog.Description>
                  <Show when={trackedJob()}>{tracked => <Button type="button" variant="outline" onClick={viewTrackedJob}>View {tracked().status === "done" ? "result" : tracked().status === "failed" ? "error" : "progress"}</Button>}</Show>
                  <LibraryHistory />
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          </Show>
          <Show when={selectedJobRefreshError()}><p role="alert" class="auth-error">{selectedJobRefreshError()}</p></Show>
      <SubmitForm onSubmitted={onSubmitted} />

      <Show when={job()}>
        <div class="processing-results" ref={progressTarget} tabIndex={-1}>
          <Show when={isActive()}>
            <QueueStatus job={job()!} />
          </Show>

          <Show when={isDone()}>
            <ResultsView job={job()!} onReset={onReset} scrollRequest={historyScrollRequest()} />
          </Show>
          <Show when={job()?.status === "failed"}>
            <section role="alert">
              <h2>Processing failed</h2>
              <p>{job()?.error_message || "The job failed."}</p>
              <Show when={retryError()?.jobId === job()?.id}><p>{retryError()!.message}</p></Show>
              <Button type="button" variant="outline" class="min-h-11" disabled={retryingId() !== null} onClick={() => void retrySelectedJob()}>
                {retryingId() === job()?.id ? "Retrying..." : "Retry"}
              </Button>
            </section>
          </Show>
        </div>
      </Show>
        </div>
      </div>


      </div>
      <Show when={trackedJob()}>{tracked => <JobStatusDock job={tracked()} onView={viewTrackedJob} />}</Show>
    </main>
  );
};

export default App;
