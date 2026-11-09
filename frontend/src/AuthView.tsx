import { createSignal, Show, type Component } from "solid-js";
import { authStart, authVerify, AuthHttpError } from "./api";
import { Button } from "~/components/button";

const messageFor = (error: unknown) => error instanceof AuthHttpError && error.status === 429
  ? "Too many requests. Please wait before trying again."
  : error instanceof Error ? error.message : "Something went wrong. Please try again.";

const AuthView: Component<{ onVerified: () => Promise<void> }> = (props) => {
  const [mode, setMode] = createSignal<"login" | "register">("login");
  const [email, setEmail] = createSignal("");
  const [invite, setInvite] = createSignal("");
  const [code, setCode] = createSignal("");
  const [step, setStep] = createSignal<"email" | "code">("email");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [message, setMessage] = createSignal("");
  const start = async (event?: Event) => {
    event?.preventDefault();
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await authStart(email().trim(), mode() === "register" ? invite().trim() : undefined);
      setMessage(result.message);
      setStep("code");
    } catch (err) { setError(messageFor(err)); }
    finally { setBusy(false); }
  };
  const verify = async (event: Event) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await authVerify(email().trim(), code().trim(), mode() === "register" ? invite().trim() : undefined);
      await props.onVerified();
    } catch (err) { setError(messageFor(err)); }
    finally { setBusy(false); }
  };
  const reset = () => { setStep("email"); setCode(""); setMessage(""); setError(""); };
  return <main class="auth-shell">
    <section class="auth-card">
      <header><p class="auth-eyebrow">ehpc's Vocal Tools</p><h1>{mode() === "login" ? "Welcome back" : "Join the workspace"}</h1><p>Private audio tools, shared by invitation.</p></header>
      <Show when={step() === "email"} fallback={<form class="auth-form" onSubmit={verify}>
        <p>Enter the verification code sent to <strong>{email()}</strong>.</p>
        <label for="auth-code">Verification code</label>
        <input id="auth-code" autocomplete="one-time-code" inputmode="numeric" value={code()} onInput={(event) => setCode(event.currentTarget.value)} required />
        <Button type="submit" class="auth-action" disabled={busy()}>{busy() ? "Verifying…" : "Verify code"}</Button>
        <div class="auth-links"><Button type="button" variant="link" disabled={busy()} onClick={reset}>Change email or start over</Button><Button type="button" variant="link" disabled={busy()} onClick={() => void start()}>Resend code</Button></div>
      </form>}>
        <div class="auth-mode" aria-label="Sign in or register"><button type="button" aria-pressed={mode() === "login"} onClick={() => { setMode("login"); reset(); }}>Sign in</button><button type="button" aria-pressed={mode() === "register"} onClick={() => { setMode("register"); reset(); }}>Register</button></div>
        <form class="auth-form" onSubmit={start}>
          <label for="auth-email">Email address</label><input id="auth-email" type="email" autocomplete="email" value={email()} onInput={(event) => setEmail(event.currentTarget.value)} required />
          <Show when={mode() === "register"}><label for="auth-invite">Invitation code</label><input id="auth-invite" autocomplete="off" value={invite()} onInput={(event) => setInvite(event.currentTarget.value)} required /></Show>
          <Button type="submit" class="auth-action" disabled={busy()}>{busy() ? "Sending…" : "Send verification code"}</Button>
        </form>
      </Show>
      <Show when={message()}><p class="auth-message" role="status">{message()}</p></Show>
      <Show when={error()}><p class="auth-error" role="alert">{error()}</p></Show>
    </section>
  </main>;
};
export default AuthView;
