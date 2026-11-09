import { render } from "solid-js/web";
import { Show } from "solid-js";
import App from "./App";
import StatusPage from "./StatusPage";
import AuthProvider, { useAuth } from "./AuthProvider";
import "./index.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element #root not found");
}

// Direct-link ops page; everything else is the main app. No router needed since
// there is no client-side navigation between them.
const Page = window.location.pathname === "/status"
  ? () => <Show when={useAuth().profile().is_admin} fallback={<main class="auth-shell"><section class="auth-card"><h1>Access denied</h1><p>Administrator access is required to view status.</p><a href="/">Back to workspace</a></section></main>}><StatusPage /></Show>
  : App;

render(() => <AuthProvider><Page /></AuthProvider>, root);
