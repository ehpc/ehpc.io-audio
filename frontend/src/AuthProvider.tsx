import { createContext, createSignal, onCleanup, onMount, Show, useContext, type Accessor, type ParentComponent } from "solid-js";
import { authActivity, authLogout, authMe, AuthHttpError, onUnauthorized, type AuthProfile } from "./api";
import AuthView from "./AuthView";

interface AuthContextValue {
  profile: Accessor<AuthProfile>;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}
const AuthContext = createContext<AuthContextValue>();
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("AuthProvider is missing");
  return value;
}

const AuthProvider: ParentComponent = (props) => {
  const [profile, setProfile] = createSignal<AuthProfile | null>(null);
  const [state, setState] = createSignal<"boot" | "ready" | "error">("boot");
  const [error, setError] = createSignal("");
  let generation = 0;
  let lastActivity = Number.NEGATIVE_INFINITY;
  let activityPending = false;
  const clear = () => {
    generation++;
    document.querySelectorAll("audio").forEach((audio) => audio.pause());
    setProfile(null);
    setState("ready");
  };
  const refresh = async () => {
    const current = generation;
    try {
      const next = await authMe();
      if (current !== generation) return;
      if (profile() && profile()!.id !== next.id) {
        document.querySelectorAll("audio").forEach((audio) => audio.pause());
      }
      setProfile(next);
      setState("ready");
    } catch (err) {
      if (current !== generation) return;
      if (err instanceof AuthHttpError && err.status === 401) clear();
      else {
        setError(err instanceof Error ? err.message : "Unable to contact the server.");
        if (!profile()) setState("error");
        throw err;
      }
    }
  };
  const logout = async () => {
    await authLogout();
    clear();
  };
  onMount(() => {
    const unsubscribe = onUnauthorized(clear);
    const activity = (event: Event) => {
      if (!event.isTrusted || document.visibilityState !== "visible" || !profile() || activityPending) return;
      const now = Date.now();
      if (now - lastActivity < 60_000) return;
      lastActivity = now;
      activityPending = true;
      void authActivity().catch(() => {}).finally(() => { activityPending = false; });
    };
    document.addEventListener("pointerdown", activity, true);
    const audioError = (event: Event) => {
      if (event.target instanceof HTMLAudioElement && profile()) void authMe().catch(() => {});
    };
    document.addEventListener("error", audioError, true);
    document.addEventListener("keydown", activity, true);
    void refresh().catch(() => {});
    onCleanup(() => {
      unsubscribe();
      document.removeEventListener("pointerdown", activity, true);
      document.removeEventListener("keydown", activity, true);
      document.removeEventListener("error", audioError, true);
    });
  });
  return (
    <Show when={state() !== "boot"} fallback={<main class="auth-shell" role="status">Checking your session…</main>}>
      <Show when={state() !== "error"} fallback={<main class="auth-shell"><section class="auth-card"><h1>Unable to connect</h1><p role="alert">{error()}</p><button class="auth-button" onClick={() => { setState("boot"); void refresh().catch(() => {}); }}>Try again</button></section></main>}>
        <Show when={profile()?.id} keyed fallback={<AuthView onVerified={refresh} />}>
          {(_id) => <AuthContext.Provider value={{ profile: () => profile()!, refresh, logout }}>{props.children}</AuthContext.Provider>}
        </Show>
      </Show>
    </Show>
  );
};
export default AuthProvider;
