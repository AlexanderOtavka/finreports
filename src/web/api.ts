import type {
  AccountDto,
  CategoryDto,
  RecategorizeRequest,
  RecategorizeResponse,
  RulePreview,
  SessionDto,
  SuggestionsDto,
  TxnDto,
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

/** No network: the request never reached the server. */
export const isOffline = (err: unknown): boolean => err instanceof ApiError && err.status === 0;

interface RequestOptions {
  body?: unknown;
  signal?: AbortSignal;
  /** On a 401, log in again (the default), or only throw. */
  loginOn401?: boolean;
}

async function request<T>(method: string, path: string, { body, signal, loginOn401 = true }: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
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
  if (res.status === 401) {
    // Session over.
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
   * Everything the app draws from, fresh. A 401 only throws: the app may still have data to
   * show, and it decides whether to log in.
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
  previewRule: (definition: RuleDefinition, excludeTxnId: number, signal?: AbortSignal) =>
    request<RulePreview>("POST", "/rules/preview", { body: { definition, excludeTxnId }, signal }),
  recategorize: (txnId: number, body: RecategorizeRequest) =>
    request<RecategorizeResponse>("POST", `/transactions/${txnId}/category`, { body }),
  /** Ends the session on the server; a 401 means it already had. */
  logout: () => request<{ ok: boolean }>("POST", "/logout", { loginOn401: false }),
};
