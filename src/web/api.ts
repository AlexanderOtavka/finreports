import type {
  AccountDto,
  CategoryDto,
  RecategorizeRequest,
  RecategorizeResponse,
  ReportData,
  RulePreview,
  SessionDto,
  SuggestionsDto,
  TxnDto,
} from "../shared/api.js";
import type { RuleDefinition } from "../shared/rules.js";

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

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
    signal,
  });
  if (res.status === 401) {
    // Session over: log in again and come back here.
    window.location.assign(`/reports/auth/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
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
  async session(): Promise<SessionDto> {
    const s = await request<SessionDto>("GET", "/session");
    csrfToken = s.csrfToken;
    return s;
  },
  categories: () => request<CategoryDto[]>("GET", "/categories"),
  categoryOrder: () => request<string[]>("GET", "/category-order"),
  accounts: () => request<AccountDto[]>("GET", "/accounts"),
  /** Every transaction; the reports run over them in the browser. */
  transactions: () => request<TxnDto[]>("GET", "/transactions"),
  suggestions: (txnId: number) => request<SuggestionsDto>("GET", `/transactions/${txnId}/suggestions`),
  previewRule: (definition: RuleDefinition, excludeTxnId: number, signal?: AbortSignal) =>
    request<RulePreview>("POST", "/rules/preview", { definition, excludeTxnId }, signal),
  recategorize: (txnId: number, body: RecategorizeRequest) =>
    request<RecategorizeResponse>("POST", `/transactions/${txnId}/category`, body),
};
