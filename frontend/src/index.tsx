import { render } from "solid-js/web";
import App from "./App";
import StatusPage from "./StatusPage";
import "./index.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element #root not found");
}

// Direct-link ops page; everything else is the main app. No router needed since
// there is no client-side navigation between them.
const Page = window.location.pathname === "/status" ? StatusPage : App;

render(() => <Page />, root);
