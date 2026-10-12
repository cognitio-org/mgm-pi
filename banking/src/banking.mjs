import { ConfigError } from "./config.mjs";
import { maskSensitive } from "./redact.mjs";

const DEFAULT_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

const PSU_FILLERS = {
  psuipaddress: (ctx) => ctx.ip || "127.0.0.1",
  psuuseragent: (ctx) => ctx.userAgent || DEFAULT_UA,
  psureferer: (ctx) => ctx.referer,
  psuaccept: () => "*/*",
  psuacceptlanguage: () => "en",
  psuacceptencoding: () => "identity",
  psudeviceid: (ctx) => ctx.deviceId,
};

export function assertCountry(value) {
  if (typeof value !== "string" || !/^[A-Za-z]{2}$/.test(value)) {
    throw new Error("country must be a two-letter code, for example FI.");
  }
  return value.toUpperCase();
}

export function wholeNumber(value, fallback, min, max, label) {
  if (value == null || value === "") return fallback;
  const n = typeof value === "number"
    ? value
    : (typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  }
  return n;
}

export function validUntilFrom(now, requestedDays, maxSeconds) {
  if (!Number.isFinite(maxSeconds) || maxSeconds < 120) {
    throw new Error("This bank did not report a usable maximum consent length.");
  }
  const requested = requestedDays * 24 * 60 * 60;
  const seconds = Math.min(requested, maxSeconds - 60);
  if (seconds < 60) throw new Error("This bank's maximum consent is too short for this proof of concept.");
  return new Date(now.getTime() + seconds * 1000);
}

export function formatValidUntil(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, ".000000+00:00");
}

export function consentBody({ aspsp, state, redirectUrl, validUntil, psuType }) {
  if (psuType !== "personal" && psuType !== "business") {
    throw new Error("psu type must be personal or business.");
  }
  return {
    access: {
      balances: true,
      transactions: true,
      valid_until: validUntil,
    },
    aspsp: { name: aspsp.name, country: aspsp.country },
    state,
    redirect_url: redirectUrl,
    psu_type: psuType,
  };
}

export function matchBank(aspsps, name) {
  if (!name || typeof name !== "string") throw new Error("Pass the bank name, for example \"Mock ASPSP\".");
  const want = name.trim().toLowerCase();
  const list = Array.isArray(aspsps) ? aspsps : [];
  const exact = list.filter((bank) => bank.name?.toLowerCase() === want);
  if (exact.length === 1) return exact[0];
  const partial = list.filter((bank) => bank.name?.toLowerCase().includes(want));
  if (partial.length === 1) return partial[0];
  const sample = list.slice(0, 12).map((bank) => bank.name).join(", ");
  throw new Error(`No single bank matches "${name}". Banks for this country include: ${sample || "(none)"}`);
}

export function psuHeaders(required, ctx) {
  if (!required?.length) return {};
  const headers = {};
  for (const name of required) {
    if (typeof name !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(name)) {
      throw new Error("This bank asked for a header name this program will not send.");
    }
    const key = name.toLowerCase().replace(/[^a-z]/g, "");
    const fill = PSU_FILLERS[key];
    if (!fill) throw new Error(`This bank requires a browser header this proof of concept does not send (${name}).`);
    const value = fill(ctx);
    if (!value) throw new Error(`This bank requires ${name}. Link the account again.`);
    headers[name] = value;
  }
  return headers;
}

export function headerContext(session, config) {
  return {
    ip: "127.0.0.1",
    userAgent: session?.psuUserAgent || DEFAULT_UA,
    referer: config.redirectUrl,
    deviceId: session?.deviceId || null,
  };
}

export function needsDeviceId(required) {
  return (required || []).some((name) => String(name).toLowerCase().replace(/[^a-z]/g, "") === "psudeviceid");
}

export function assertApplication(app, config) {
  const warnings = [];
  if (!app?.active) throw new ConfigError("APP", "The Enable Banking application is not active.");
  const expected = config.environment === "production" ? "PRODUCTION" : "SANDBOX";
  if (app.environment !== expected) {
    throw new ConfigError(
      "PRODUCTION",
      `The private key belongs to a ${app.environment} application, while config.env says ${config.environment}. Refusing to continue.`,
    );
  }
  if (app.kid && app.kid.toLowerCase() !== config.appId) {
    throw new ConfigError("APP", "The application id in the response does not match ENABLEBANKING_APP_ID.");
  }
  if (!Array.isArray(app.redirect_urls) || !app.redirect_urls.includes(config.redirectUrl)) {
    throw new ConfigError(
      "REDIRECT",
      `Add this redirect URL to the Enable Banking application, exactly: ${config.redirectUrl}`,
    );
  }
  if (Array.isArray(app.services) && app.services.includes("PIS")) {
    warnings.push("This Enable Banking application has payment initiation turned on. This program never calls payment endpoints.");
  }
  return {
    name: app.name,
    environment: app.environment,
    redirectUrl: config.redirectUrl,
    services: app.services || [],
    countries: app.countries || [],
    warnings,
  };
}

export function assertAuthUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enable Banking did not return a login URL.");
  }
  if (url.protocol !== "https:") throw new Error("The bank login URL was not https.");
  return url.toString();
}

export function rememberAccount(account, index) {
  if (!account || typeof account !== "object" || typeof account.uid !== "string") return null;
  if (!/^[0-9a-f-]{36}$/i.test(account.uid)) {
    throw new Error("Enable Banking returned an account id that is not a UUID. Nothing was saved.");
  }
  const iban = typeof account.account_id?.iban === "string" ? account.account_id.iban.replace(/\s+/g, "") : "";
  return {
    index,
    uid: account.uid.toLowerCase(),
    name: typeof account.name === "string" ? account.name.slice(0, 80) : null,
    currency: typeof account.currency === "string" ? account.currency : null,
    product: typeof account.product === "string" ? account.product.slice(0, 80) : null,
    cashAccountType: typeof account.cash_account_type === "string" ? account.cash_account_type : null,
    ibanLast4: iban ? iban.slice(-4) : null,
  };
}

export function assertTransactionId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value) || value.includes("..")) {
    throw new Error("Pass the transaction id printed by transactions. It may contain letters, numbers, and . _ : -.");
  }
  return value;
}

function defined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value != null));
}

function text(value, max = 120) {
  if (typeof value !== "string" || !value.trim()) return null;
  return maskSensitive(value).replace(/\s+/g, " ").trim().slice(0, max);
}

function maskTail(value) {
  const compact = String(value ?? "").replace(/\s+/g, "");
  if (!compact) return null;
  const masked = maskSensitive(compact);
  if (masked !== compact) return masked;
  if (compact.length <= 4) return "••••";
  return `••••${compact.slice(-4)}`;
}

function projectAmount(amount) {
  if (!amount || typeof amount.amount !== "string" || !/^-?\d+(\.\d+)?$/.test(amount.amount)) return null;
  const currency = typeof amount.currency === "string" && /^[A-Za-z]{3}$/.test(amount.currency) ? amount.currency.toUpperCase() : null;
  return { amount: amount.amount, currency };
}

function projectIdentifier(entry) {
  if (!entry || typeof entry !== "object" || typeof entry.identification !== "string") return null;
  const scheme = typeof entry.scheme_name === "string" ? entry.scheme_name.slice(0, 32) : "other";
  const id = maskTail(entry.identification);
  return id ? { scheme, id } : null;
}

function projectAddress(address) {
  if (!address || typeof address !== "object") return null;
  const out = {};
  for (const key of ["street_name", "building_number", "post_code", "town_name", "country_sub_division", "country"]) {
    const value = text(address[key], 80);
    if (value) out[key] = value;
  }
  if (Array.isArray(address.address_line)) {
    const lines = address.address_line.map((line) => text(line, 120)).filter(Boolean);
    if (lines.length) out.lines = lines.slice(0, 4);
  }
  return Object.keys(out).length ? out : null;
}

export function projectAccountDetails(account) {
  if (!account || typeof account !== "object") throw new Error("Enable Banking returned no account details.");
  const identifiers = [];
  if (typeof account.account_id?.iban === "string" && account.account_id.iban.trim()) {
    identifiers.push({ scheme: "IBAN", id: maskTail(account.account_id.iban) });
  }
  const other = projectIdentifier(account.account_id?.other);
  if (other) identifiers.push(other);
  for (const item of Array.isArray(account.all_account_ids) ? account.all_account_ids : []) {
    const projected = projectIdentifier(item);
    if (projected) identifiers.push(projected);
  }
  const seen = new Set();
  const unique = identifiers.filter((item) => {
    const key = `${item.scheme}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const servicer = account.account_servicer && typeof account.account_servicer === "object" ? account.account_servicer : null;
  return defined({
    name: text(account.name, 80),
    currency: typeof account.currency === "string" ? account.currency : null,
    product: text(account.product, 80),
    type: typeof account.cash_account_type === "string" ? account.cash_account_type : null,
    usage: typeof account.usage === "string" ? account.usage : null,
    details: text(account.details, 160),
    holderRole: text(account.psu_status, 40),
    creditLimit: projectAmount(account.credit_limit),
    legalAge: typeof account.legal_age === "boolean" ? account.legal_age : null,
    identifiers: unique,
    servicer: servicer && (servicer.name || servicer.bic_fi) ? defined({ name: text(servicer.name, 80), bic: text(servicer.bic_fi, 16) }) : null,
    address: projectAddress(account.postal_address),
  });
}

export function projectAccount(account) {
  return {
    index: account.index,
    name: account.name,
    currency: account.currency,
    product: account.product,
    type: account.cashAccountType,
    iban: account.ibanLast4 ? `••••${account.ibanLast4}` : null,
  };
}

export function selectAccount(accounts, which) {
  if (!accounts?.length) throw new Error("No account is linked. Run: node src/cli.mjs link --country FI --name \"Mock ASPSP\"");
  if (which == null || which === "") {
    if (accounts.length === 1) return accounts[0];
    throw new Error(`Several accounts are linked. Pass --account 1 to ${accounts.length}.`);
  }
  const text = String(which).trim();
  if (/^\d+$/.test(text)) {
    const found = accounts.find((account) => account.index === Number(text));
    if (!found?.uid) throw new Error(`There is no readable account ${text}.`);
    return found;
  }
  const matches = accounts.filter((account) => account.ibanLast4 === text);
  if (matches.length === 1) return matches[0];
  throw new Error(`No single linked account ends in ${text}.`);
}

export function projectBalance(balance) {
  return {
    name: balance.name || null,
    type: balance.balance_type || null,
    amount: balance.balance_amount?.amount ?? null,
    currency: balance.balance_amount?.currency || null,
    asOf: balance.reference_date || balance.last_change_date_time || null,
  };
}

function projectPartyAccount(partyAccount) {
  if (!partyAccount || typeof partyAccount !== "object") return null;
  if (typeof partyAccount.iban === "string" && partyAccount.iban.trim()) return { scheme: "IBAN", id: maskTail(partyAccount.iban) };
  return projectIdentifier(partyAccount.other) || projectIdentifier(partyAccount);
}

export function projectTransaction(tx) {
  const other = tx.credit_debit_indicator === "DBIT" ? tx.creditor : tx.debtor;
  const otherAccount = tx.credit_debit_indicator === "DBIT" ? tx.creditor_account : tx.debtor_account;
  const detail = Array.isArray(tx.remittance_information) ? tx.remittance_information.join(" ") : "";
  const code = tx.bank_transaction_code && typeof tx.bank_transaction_code === "object" ? tx.bank_transaction_code : null;
  const rate = tx.exchange_rate && typeof tx.exchange_rate === "object" ? tx.exchange_rate : null;
  const id = typeof tx.transaction_id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(tx.transaction_id) && !tx.transaction_id.includes("..")
    ? tx.transaction_id
    : null;
  return defined({
    id,
    date: tx.booking_date || tx.transaction_date || tx.value_date || null,
    valueDate: tx.value_date || null,
    transactionDate: tx.transaction_date || null,
    status: tx.status || null,
    direction: tx.credit_debit_indicator === "CRDT" ? "credit" : tx.credit_debit_indicator === "DBIT" ? "debit" : tx.credit_debit_indicator || null,
    amount: tx.transaction_amount?.amount ?? null,
    currency: tx.transaction_amount?.currency || null,
    balanceAfter: projectAmount(tx.balance_after_transaction),
    counterparty: other?.name ? maskSensitive(other.name).slice(0, 80) : null,
    counterpartyAccount: projectPartyAccount(otherAccount),
    detail: detail ? maskSensitive(detail).slice(0, 120) : null,
    reference: text(tx.reference_number, 40),
    merchantCategory: text(tx.merchant_category_code, 8),
    category: code ? text(code.description || code.code, 80) : null,
    subcategory: code ? text(code.sub_code, 32) : null,
    note: text(tx.note, 120),
    entryReference: text(tx.entry_reference, 40),
    exchangeRate: rate && (rate.exchange_rate || rate.instructed_amount) ? defined({
      rate: text(rate.exchange_rate, 32),
      unitCurrency: text(rate.unit_currency, 3),
      instructed: projectAmount(rate.instructed_amount),
    }) : null,
  });
}

export function sessionView(session, now) {
  if (!session) return { linked: false, expired: false, accounts: 0, bank: null, validUntil: null };
  const until = new Date(session.validUntil);
  const expired = Number.isNaN(until.getTime()) || until.getTime() <= now.getTime();
  return {
    linked: !expired,
    expired,
    accounts: Array.isArray(session.accounts) ? session.accounts.length : 0,
    bank: session.aspsp ? `${session.aspsp.name} (${session.aspsp.country})` : null,
    validUntil: session.validUntil || null,
  };
}

export function requireSession(session, now) {
  const view = sessionView(session, now);
  if (!session || view.expired) {
    throw new Error("No current bank link. Run: node src/cli.mjs link --country FI --name \"Mock ASPSP\"");
  }
  if (session.version !== 1 || typeof session.sessionId !== "string") {
    throw new Error("The saved bank link is from an older preview. Run unlink, then link again.");
  }
  return session;
}

export function readCallbackQuery(requestUrl, expectedState) {
  const url = new URL(requestUrl, "http://127.0.0.1");
  if (url.pathname !== "/callback") return { status: 404, body: "Not found." };
  if (url.searchParams.get("state") !== expectedState) {
    return { status: 400, body: "This login does not match the one started on this computer. Close this tab and run link again." };
  }
  const error = url.searchParams.get("error");
  if (error) {
    const safe = /^[A-Za-z0-9_]{1,64}$/.test(error) ? error : "declined";
    return { status: 400, body: `The bank declined the login (${safe}).`, failed: true };
  }
  const code = url.searchParams.get("code");
  if (!code || code.length > 512 || /[\r\n]/.test(code)) {
    return { status: 400, body: "The bank did not return a login code.", failed: true };
  }
  return { status: 200, body: "Link complete. You can close this tab.", code };
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[ch]);
}

export function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export { DEFAULT_UA };
