import "./AccessGate.css";

import { type FormEvent, useRef, useState } from "react";

import { ApiError, authenticate } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { userErrorMessage, type UserError } from "../lib/userError.ts";


export interface AccessGateProps {
  /** Fires once the server set a cookie: the shell can mount, and every later fetch and the WebSocket carry it. */
  onUnlocked: () => void;
}

/**
 * Sign-in screen rendered instead of the shell while the server does not know this
 * browser: the shared access token, typed once. Nothing is stored here: the server
 * answers with an HttpOnly cookie.
 */
export function AccessGate({ onUnlocked }: AccessGateProps) {
  const t = useT();
  const tokenRef = useRef<HTMLInputElement | null>(null);
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<UserError | null>(null);

  const submitToken = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    if (token === "") { tokenRef.current?.focus(); return; }
    setSubmitting(true);
    setError(null);
    try {
      await authenticate(token);
      onUnlocked();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? { message: t("Token does not match."), detail: null } : userErrorMessage(err));
      setSubmitting(false);
      tokenRef.current?.select();
    }
  };

  return (
    <main className="access-gate-screen">
      <div className="access-gate" data-testid="token-gate">
        <img src="/icons/icon-192.png?v=sheep1" alt="" width="44" height="44" className="access-gate-mark" />
        <h1 id="access-gate-title" className="access-gate-title">
          Ovis
        </h1>
        <p className="access-gate-copy">{t("This server requires an access token.")}</p>
        <form aria-labelledby="access-gate-title" onSubmit={(event) => void submitToken(event)}>
          <label className="access-gate-label" htmlFor="access-gate-token">{t("Access token")}</label>
          <input
            ref={tokenRef}
            id="access-gate-token"
            className="access-gate-input"
            type="password"
            name="token"
            autoComplete="current-password"
            inputMode="text"
            autoFocus
            aria-invalid={error !== null}
            aria-describedby={error !== null ? "access-gate-error" : undefined}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <button type="submit" className="access-gate-submit" disabled={submitting}>
            {t(submitting ? "Unlocking…" : "Unlock")}
          </button>
        </form>
        {error !== null && (
          <p id="access-gate-error" className="access-gate-error" role="alert">{error.message}{error.detail !== null && <><br /><code>{error.detail}</code></>}</p>
        )}
      </div>
    </main>
  );
}
