import { api, useResource } from "./api/client";
import { ErrorState, Loading } from "./components/States";
import { Dashboard } from "./pages/Dashboard";

export function App() {
  const meta = useResource("meta", (s) => api.meta(s));

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="header">
        <div className="container">
          <p className="eyebrow">Day-ahead procurement · GB national wind</p>
          <h1>Wind Forecast Decision Monitor</h1>
          <ul className="facts">
            <li>All times UK local (GMT or BST, as labelled)</li>
            <li>Power in MW</li>
            <li>
              Sources: Elexon BMRS <span translate="no">WINDFOR</span> forecasts and <span translate="no">FUELHH</span> wind outturn
            </li>
          </ul>
        </div>
      </header>
      <main id="main" className="container" tabIndex={-1}>
        {meta.error && <ErrorState message={meta.error} onRetry={meta.retry} />}
        {!meta.error && !meta.data && <Loading label="Connecting to the API…" />}
        {meta.data && <Dashboard meta={meta.data} />}
      </main>
      <footer className="footer container">
        <p>
          Error = forecast − actual: positive means more wind was forecast than generated, so less power was bought than
          needed. MAPE is not reported because wind output can approach zero.
        </p>
      </footer>
    </>
  );
}
