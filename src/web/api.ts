import type {
  AccountDto,
  BuilderDto,
  CategoryDto,
  RecategorizeRequest,
  RecategorizeResponse,
  RulePreviewCounts,
  SaveRuleResponse,
  SessionDto,
  SuggestionsDto,
  TxnDto,
  UiContext,
} from "../shared/api.js";
import type { RuleDefinition } from "../shared/rules.js";
import type { Snapshot } from "./store.js";

const BASE = "/reports/api";
let csrfToken: string | null = null;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Logs in again and comes back here. */
export function login(): void {
  window.location.assign(`/reports/auth/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
}

let renewing: Promise<boolean> | null = null;

/**
 * Logs in again without leaving the page, when that takes no one: while Firefly's own session
 * is alive and this client is approved, the login is only redirects (to Firefly's authorize,
 * back to the callback, which sets a new session cookie), and a fetch follows them all the
 * same. It ends at the new session, whose CSRF token it keeps. Anything else (Firefly's login
 * or approval page, a refused login, no network) leaves it to login(). Calls at once share one
 * attempt.
 */
export function renewSession(): Promise<boolean> {
  renewing ??= (async () => {
    try {
      const res = await fetch(`/reports/auth/login?next=${encodeURIComponent(`${BASE}/session`)}`, {
        // Firefly answers a JSON request without a session with a 401, rather than its login page.
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      });
      if (!res.ok || new URL(res.url).pathname !== `${BASE}/session`) return false;
      csrfToken = ((await res.json()) as SessionDto).csrfToken;
      return true;
    } catch {
      return false;
    } finally {
      renewing = null;
    }
  })();
  return renewing;
}

/** No network: the request never reached the server. */
export const isOffline = (err: unknown): boolean => err instanceof ApiError && err.status === 0;

interface RequestOptions {
  body?: unknown;
  signal?: AbortSignal;
  /** On a 401, renew the session in the background and try again once (the default), or not. */
  renew?: boolean;
  /** On a 401 the renewal does not fix, log in again (the default), or only throw. */
  loginOn401?: boolean;
}

async function request<T>(method: string, path: string, { body, signal, renew = true, loginOn401 = true }: RequestOptions = {}): Promise<T> {
  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
    try {
      return await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
        signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      throw new ApiError("you're offline", 0);
    }
  };
  let res = await send();
  // Session over: a new one, if Firefly gives it without asking, and the same request again.
  if (res.status === 401 && renew && (await renewSession())) res = await send();
  if (res.status === 401) {
    if (loginOn401) login();
    throw new ApiError("login required", 401);
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      // not JSON
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}

export interface ReportQuery {
  reportId: string;
  from: string;
  to: string;
  path: string[];
  /** Only these accounts' transactions; null for all. */
  accounts: string[] | null;
}

export const api = {
  /**
   * Everything the app draws from, fresh. A 401 the renewal does not fix only throws: the app
   * may still have data to show, and it decides whether to log in.
   */
  async snapshot(): Promise<{ session: SessionDto } & Omit<Snapshot, "session" | "fetchedAt">> {
    const get = <T>(path: string) => request<T>("GET", path, { loginOn401: false });
    const [session, categories, categoryOrder, accounts, txns] = await Promise.all([
      get<SessionDto>("/session"),
      get<CategoryDto[]>("/categories"),
      get<string[]>("/category-order"),
      get<AccountDto[]>("/accounts"),
      get<TxnDto[]>("/transactions"),
    ]);
    csrfToken = session.csrfToken;
    return { session, categories, categoryOrder, accounts, txns };
  },
  /** Every transaction; the reports run over them in the browser. */
  transactions: () => request<TxnDto[]>("GET", "/transactions"),
  suggestions: (txnId: number) => request<SuggestionsDto>("GET", `/transactions/${txnId}/suggestions`),
  previewRule: (definition: RuleDefinition, excludeTxnId: number | undefined, signal?: AbortSignal) =>
    request<RulePreviewCounts>("POST", "/rules/preview", { body: { definition, excludeTxnId }, signal }),
  saveRule: (definition: RuleDefinition, applyToPast: boolean, uiContext: UiContext) =>
    request<SaveRuleResponse>("POST", "/rules", { body: { definition, applyToPast, uiContext } }),
  /** Transactions missing a merchant or a category, grouped, with the merchants to copy from. */
  rulesBuilder: (signal?: AbortSignal) => request<BuilderDto>("GET", "/rules-builder", { signal }),
  recategorize: (txnId: number, body: RecategorizeRequest) =>
    request<RecategorizeResponse>("POST", `/transactions/${txnId}/category`, { body }),
  /** Ends the session on the server; a 401 means it already had. */
  logout: () => request<{ ok: boolean }>("POST", "/logout", { renew: false, loginOn401: false }),
};
