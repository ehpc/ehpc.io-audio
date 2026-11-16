import { createSignal, onCleanup, onMount, Show, type Component } from "solid-js";
import * as Dialog from "@kobalte/core/dialog";
import type { JobDTO } from "./api";
import { getCurrentJob, listJobs } from "./api";
import SubmitForm from "./components/SubmitForm";
import QueueStatus from "./components/QueueStatus";
import ResultsView, { type HistoryScrollRequest } from "./components/ResultsView";
import HistoryView from "./components/HistoryView";
import { useAuth } from "./AuthProvider";
import ProfileView from "./ProfileView";
import AdminView from "./AdminView";
import { Button } from "~/components/button";

const App: Component = () => {
  const [job, setJob] = createSignal<JobDTO | null>(null);
  const [history, setHistory] = createSignal<JobDTO[]>([]);
  const [historyScrollRequest, setHistoryScrollRequest] = createSignal<HistoryScrollRequest | null>(null);
  let historyScrollToken = 0;
  const deletedJobIds = new Set<number>();
  const auth = useAuth();
  const [tab, setTab] = createSignal<"workspace" | "profile" | "people">("workspace");
  const [accountError, setAccountError] = createSignal("");
  const [mobileLibrary, setMobileLibrary] = createSignal(false);
  const [libraryOpen, setLibraryOpen] = createSignal(false);
  let libraryTrigger: HTMLButtonElement | undefined;
  let selectedFromLibrary = false;

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
    try {
      const jobs = await listJobs();
      setHistory(jobs.filter((item) => !deletedJobIds.has(item.id)));
    } catch {
      // leave the previous list in place if this refresh fails
    }
  };

  onMount(async () => {
    try {
      setJob(await getCurrentJob());
    } catch {
      setJob(null);
    }
    refreshHistory();
  });

  const onSubmitted = (newJob: JobDTO) => {
    setLibraryOpen(false);
    setHistoryScrollRequest(null);
    setJob(newJob);
    refreshHistory();
  };

  const onHistorySelect = (selected: JobDTO) => {
    setJob(selected);
    if (libraryOpen()) {
      selectedFromLibrary = true;
      setLibraryOpen(false);
    }
    setHistoryScrollRequest({ jobId: selected.id, token: ++historyScrollToken });
  };
  const onReset = () => {
    setHistoryScrollRequest(null);
    setJob(null);
  };

  const onTerminal = (finished: JobDTO) => {
    setHistoryScrollRequest(null);
    setJob(finished);
    refreshHistory();
  };

  const isActive = () => job()?.status === "queued" || job()?.status === "running";
  const isDone = () => job()?.status === "done";

  const onDeleted = (id: number) => {
    deletedJobIds.add(id);
    setHistory((items) => items.filter((item) => item.id !== id));
    if (job()?.id === id) {
      setHistoryScrollRequest(null);
      setJob(null);
    }
  };
  const LibraryHistory = () => <HistoryView jobs={history()} selectedId={job()?.id} onSelect={onHistorySelect} onRetried={onSubmitted} onDeleted={onDeleted} />;

  return (
    <main class="app-shell">
      <header class="app-header">
        <h1>ehpc's Vocal Tools</h1>
        <p>Your audio workspace</p>
      </header>
      <nav class="account-nav" aria-label="Account navigation">
        <div class="account-tabs">
          <Button variant={tab() === "workspace" ? "secondary" : "ghost"} aria-pressed={tab() === "workspace"} onClick={() => setTab("workspace")}>Workspace</Button>
          <Button variant={tab() === "profile" ? "secondary" : "ghost"} aria-pressed={tab() === "profile"} onClick={() => setTab("profile")}>Profile</Button>
          <Show when={auth.profile().is_admin}><Button variant={tab() === "people" ? "secondary" : "ghost"} aria-pressed={tab() === "people"} onClick={() => setTab("people")}>People</Button></Show>
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
                  if (selectedFromLibrary) {
                    event.preventDefault();
                    selectedFromLibrary = false;
                    libraryTrigger?.focus({ preventScroll: true });
                  }
                }}>
                  <div class="library-drawer-header"><Dialog.Title>Library</Dialog.Title><Dialog.CloseButton as={Button} type="button" variant="outline" aria-label="Close library">Close</Dialog.CloseButton></div>
                  <Dialog.Description class="sr-only">Choose a song to open its results.</Dialog.Description>
                  <LibraryHistory />
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          </Show>
      <SubmitForm onSubmitted={onSubmitted} />

      <Show when={isActive() || isDone()}>
        <div class="processing-results">
          <Show when={isActive()}>
            <QueueStatus job={job()!} onTerminal={onTerminal} />
          </Show>

          <Show when={isDone()}>
            <ResultsView job={job()!} onReset={onReset} scrollRequest={historyScrollRequest()} />
          </Show>
        </div>
      </Show>
        </div>
      </div>


      </div>
    </main>
  );
};

export default App;
