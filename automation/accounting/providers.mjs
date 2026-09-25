import { providerFetch, jsonResponse, formBody } from './http.mjs';
import { AccountingError } from './errors.mjs';

const ZOHO_DEFAULT_ACCOUNTS = 'https://accounts.zoho.com';
const ZOHO_DEFAULT_API = 'https://www.zohoapis.com';
const QBO_AUTH = 'https://appcenter.intuit.com/connect/oauth2';
const QBO_TOKEN = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

const PROVIDER_NAMES = ['zoho_books', 'quickbooks'];
export const ACCOUNTING_PROVIDERS = Object.freeze(PROVIDER_NAMES);

function assertProvider(provider) {
  if (!PROVIDER_NAMES.includes(provider)) throw new TypeError(`Unsupported accounting provider: ${provider}`);
}

function accountDomain(region) {
  const suffix = String(region || 'com').replace(/^\./, '');
  if (!['com','eu','in','com.au','jp','ca','com.cn','sa'].includes(suffix)) throw new TypeError('Invalid Zoho region');
  return `https://accounts.zoho.${suffix}`;
}

export function zohoRegionFromLocation(location, fallback = 'com') {
  const value = String(location || fallback || 'com').trim().toLowerCase().replace(/^\./, '');
  const aliases = { us: 'com', eu: 'eu', in: 'in', au: 'com.au', jp: 'jp', ca: 'ca', cn: 'com.cn', sa: 'sa' };
  const region = aliases[value] || value;
  accountDomain(region);
  return region;
}

function apiDomain(region) {
  const suffix = String(region || 'com').replace(/^\./, '');
  accountDomain(suffix);
  if (suffix === 'com') return ZOHO_DEFAULT_API;
  return `https://www.zohoapis.${suffix}`;
}

function safeApiDomain(candidate, region) {
  const expected = apiDomain(region);
  if (!candidate) return expected;
  try {
    const parsed = new URL(candidate);
    const allowed = new Set(['www.zohoapis.com', 'www.zohoapis.eu', 'www.zohoapis.in', 'www.zohoapis.com.au', 'www.zohoapis.jp', 'www.zohoapis.ca', 'www.zohoapis.com.cn', 'www.zohoapis.sa']);
    return parsed.protocol === 'https:' && parsed.pathname === '/' && allowed.has(parsed.hostname) ? `https://${parsed.hostname}` : expected;
  } catch {
    return expected;
  }
}

function amountMinor(value, currency = 'USD') {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  // Accounting APIs return major units. Preserve integer minor units for the app's invoice schema.
  const zeroDecimal = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
  const scale = ['BHD','IQD','JOD','KWD','LYD','OMR','TND'].includes(String(currency).toUpperCase()) ? 1000 : zeroDecimal.has(String(currency).toUpperCase()) ? 1 : 100;
  const result = Math.round(n * scale);
  return Number.isSafeInteger(result) ? result : null;
}

function normalizeZohoInvoice(item) {
  if (!item) return null;
  const currency = item.currency_code || item.currency || null;
  const totalMinor = amountMinor(item.total, currency);
  const balanceMinor = amountMinor(item.balance, currency);
  if (!item.invoice_id || totalMinor === null || balanceMinor === null) return null;
  return {
    externalId: String(item.invoice_id),
    number: item.invoice_number || null,
    customerName: item.customer_name || item.contact_name || null,
    amountMinor: totalMinor,
    balanceMinor,
    paidMinor: Math.max(0, totalMinor - balanceMinor),
    currency: currency ? String(currency).toUpperCase() : null,
    invoiceDate: item.date || null,
    dueDate: item.due_date || null,
    status: item.status || null,
    updatedAt: item.last_modified_time || item.updated_time || null,
    source: 'zoho_books',
    raw: item,
  };
}

function normalizeZohoPayment(item) {
  const currency = item.currency_code || item.currency || null;
  const amount = amountMinor(item.amount, currency);
  if (!item.payment_id || amount === null) return null;
  return {
    externalId: String(item.payment_id),
    amountMinor: amount,
    currency: currency ? String(currency).toUpperCase() : null,
    paymentDate: item.date || null,
    reference: item.reference_number || item.description || null,
    invoiceIds: Array.isArray(item.invoices) ? item.invoices.map((x) => String(x.invoice_id || x.invoice_number)).filter(Boolean) : [],
    source: 'zoho_books',
    raw: item,
  };
}

function normalizeQboInvoice(item) {
  if (!item) return null;
  const currency = item.CurrencyRef?.value || null;
  const totalMinor = amountMinor(item.TotalAmt, currency);
  const balanceMinor = amountMinor(item.Balance, currency);
  if (!item.Id || totalMinor === null || balanceMinor === null) return null;
  return {
    externalId: String(item.Id),
    number: item.DocNumber || null,
    customerName: item.CustomerRef?.name || null,
    amountMinor: totalMinor,
    balanceMinor,
    paidMinor: Math.max(0, totalMinor - balanceMinor),
    currency: currency ? String(currency).toUpperCase() : null,
    invoiceDate: item.TxnDate || null,
    dueDate: item.DueDate || null,
    status: item.EmailStatus || null,
    updatedAt: item.MetaData?.LastUpdatedTime || null,
    source: 'quickbooks',
    raw: item,
  };
}

function normalizeQboPayment(item) {
  const currency = item.CurrencyRef?.value || null;
  const amount = amountMinor(item.TotalAmt, currency);
  if (!item.Id || amount === null) return null;
  return {
    externalId: String(item.Id),
    amountMinor: amount,
    currency: currency ? String(currency).toUpperCase() : null,
    paymentDate: item.TxnDate || null,
    reference: item.PaymentRefNum || item.PrivateNote || null,
    invoiceIds: Array.isArray(item.Line) ? item.Line.flatMap((line) => (line.LinkedTxn || []).map((x) => String(x.TxnId)).filter(Boolean)) : [],
    source: 'quickbooks',
    raw: item,
  };
}

function basic(clientId, clientSecret) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`;
}

export function createZohoBooksProvider({ clientId = process.env.ZOHO_BOOKS_CLIENT_ID, clientSecret = process.env.ZOHO_BOOKS_CLIENT_SECRET, redirectUri = process.env.ZOHO_BOOKS_REDIRECT_URI, region = process.env.ZOHO_BOOKS_REGION || 'com', fetchImpl = globalThis.fetch } = {}) {
  const scopes = 'ZohoBooks.settings.READ,ZohoBooks.invoices.READ,ZohoBooks.invoices.CREATE,ZohoBooks.invoices.UPDATE,ZohoBooks.contacts.READ,ZohoBooks.contacts.CREATE,ZohoBooks.contacts.UPDATE,ZohoBooks.customerpayments.READ,ZohoBooks.customerpayments.UPDATE';
  return {
    name: 'zoho_books',
    scopes,
    authorizationUrl({ state, redirectUri: callback = redirectUri, region: selectedRegion = region } = {}) {
      callback = String(callback || '').trim();
      if (!clientId) throw new AccountingError('ACCOUNTING_ZOHO_CLIENT_ID_MISSING', 'Zoho Books client ID is not configured');
      if (!callback) throw new AccountingError('ACCOUNTING_ZOHO_REDIRECT_URI_MISSING', 'Zoho Books redirect URI is not configured');
      const url = new URL(`${accountDomain(selectedRegion)}/oauth/v2/auth`);
      url.search = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: callback, scope: scopes, state, access_type: 'offline', prompt: 'consent' }).toString();
      return url.toString();
    },
    async exchangeCode({ code, redirectUri: callback = redirectUri, region: selectedRegion = region }) {
      callback = String(callback || '').trim();
      if (!clientId) throw new AccountingError('ACCOUNTING_ZOHO_CLIENT_ID_MISSING', 'Zoho Books client ID is not configured');
      if (!clientSecret) throw new AccountingError('ACCOUNTING_ZOHO_CLIENT_SECRET_MISSING', 'Zoho Books client secret is not configured');
      if (!callback) throw new AccountingError('ACCOUNTING_ZOHO_REDIRECT_URI_MISSING', 'Zoho Books redirect URI is not configured');
      const url = new URL(`${accountDomain(selectedRegion)}/oauth/v2/token`);
      const response = await providerFetch(fetchImpl, 'zoho_books', url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: formBody({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: callback, grant_type: 'authorization_code' }) });
      const body = await jsonResponse(response, 'zoho_books');
      if (!body.access_token || !body.refresh_token) throw new Error('Zoho Books did not return required tokens');
      return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000, accountsDomain: accountDomain(selectedRegion), apiDomain: safeApiDomain(body.api_domain, selectedRegion), region: selectedRegion };
    },
    async refreshToken({ refreshToken, region: selectedRegion = region }) {
      if (!clientId || !clientSecret || !refreshToken) throw new Error('Zoho Books client is not configured');
      const url = new URL(`${accountDomain(selectedRegion)}/oauth/v2/token`);
      const response = await providerFetch(fetchImpl, 'zoho_books', url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: formBody({ refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' }) });
      const body = await jsonResponse(response, 'zoho_books');
      if (!body.access_token) throw new Error('Zoho Books did not return an access token');
      return { accessToken: body.access_token, refreshToken: body.refresh_token || refreshToken, expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000, accountsDomain: accountDomain(selectedRegion), apiDomain: safeApiDomain(body.api_domain, selectedRegion), region: selectedRegion };
    },
    async revokeToken({ refreshToken, region: selectedRegion = region }) {
      if (!refreshToken) return;
      const url = new URL(`${accountDomain(selectedRegion)}/oauth/v2/token/revoke`);
      url.search = new URLSearchParams({ token: refreshToken }).toString();
      await providerFetch(fetchImpl, 'zoho_books', url, { method: 'POST', headers: { Accept: 'application/json' } });
    },
    async fetchOrganizations({ token }) {
      const url = new URL(`${token.apiDomain || ZOHO_DEFAULT_API}/books/v3/organizations`);
      const response = await providerFetch(fetchImpl, 'zoho_books', url, { headers: { Authorization: `Zoho-oauthtoken ${token.accessToken}`, Accept: 'application/json' } });
      const body = await jsonResponse(response, 'zoho_books');
      return (Array.isArray(body.organizations) ? body.organizations : []).filter(item => item?.organization_id).map(item => ({ id: String(item.organization_id), name: String(item.name || item.org_name || 'Zoho Books organization') }));
    },
    async fetchInvoices({ token, accountId, page = 1, perPage = 200 }) {
      if (!accountId) throw new Error('Zoho Books organization ID is required');
      const url = new URL(`${token.apiDomain || ZOHO_DEFAULT_API}/books/v3/invoices`);
      url.search = new URLSearchParams({ organization_id: accountId, page: String(page), per_page: String(perPage) }).toString();
      const response = await providerFetch(fetchImpl, 'zoho_books', url, { headers: { Authorization: `Zoho-oauthtoken ${token.accessToken}`, Accept: 'application/json' } });
      const body = await jsonResponse(response, 'zoho_books');
      const result = (Array.isArray(body.invoices) ? body.invoices : []).map(normalizeZohoInvoice).filter(Boolean);
      result.nextPage = body.page_context?.has_more_page ? Number(page) + 1 : null;
      return result;
    },
    async fetchContacts({ token, accountId, page = 1, perPage = 200 }) {
      if (!accountId) throw new Error('Zoho Books organization ID is required');
      const url = new URL(`${token.apiDomain || ZOHO_DEFAULT_API}/books/v3/contacts`);
      url.search = new URLSearchParams({ organization_id: accountId, page: String(page), per_page: String(perPage), contact_type: 'customer' }).toString();
      const response = await providerFetch(fetchImpl, 'zoho_books', url, { headers: { Authorization: `Zoho-oauthtoken ${token.accessToken}`, Accept: 'application/json' } });
      const body = await jsonResponse(response, 'zoho_books');
      const result = (Array.isArray(body.contacts) ? body.contacts : []).filter(item => item?.contact_id).map(item => ({
        externalId: String(item.contact_id), name: item.contact_name || item.company_name || null,
        companyName: item.company_name || null, email: item.email || null, phone: item.phone || null,
        contactType: item.contact_type || 'customer', status: item.status || null, currency: item.currency_code || null,
        updatedAt: item.last_modified_time || null, source: 'zoho_books', raw: item,
      }));
      result.nextPage = body.page_context?.has_more_page ? Number(page) + 1 : null;
      return result;
    },
    async fetchPayments({ token, accountId, page = 1, perPage = 200 }) {
      if (!accountId) throw new Error('Zoho Books organization ID is required');
      const url = new URL(`${token.apiDomain || ZOHO_DEFAULT_API}/books/v3/customerpayments`);
      url.search = new URLSearchParams({ organization_id: accountId, page: String(page), per_page: String(perPage) }).toString();
      const response = await providerFetch(fetchImpl, 'zoho_books', url, { headers: { Authorization: `Zoho-oauthtoken ${token.accessToken}`, Accept: 'application/json' } });
      const body = await jsonResponse(response, 'zoho_books');
      const result = (Array.isArray(body.customerpayments) ? body.customerpayments : []).map(normalizeZohoPayment).filter(Boolean);
      result.nextPage = body.page_context?.has_more_page ? Number(page) + 1 : null;
      return result;
    },
    async fetchInvoiceBalance({ token, accountId, invoiceId }) {
      if (!accountId || !invoiceId) throw new Error('Zoho Books organization and invoice IDs are required');
      const url = new URL(`${token.apiDomain || ZOHO_DEFAULT_API}/books/v3/invoices/${encodeURIComponent(invoiceId)}`);
      url.search = new URLSearchParams({ organization_id: accountId }).toString();
      const response = await providerFetch(fetchImpl, 'zoho_books', url, { headers: { Authorization: `Zoho-oauthtoken ${token.accessToken}`, Accept: 'application/json' } });
      const body = await jsonResponse(response, 'zoho_books');
      const invoice = normalizeZohoInvoice(body.invoice);
      if (!invoice || invoice.externalId !== String(invoiceId)) throw new Error('Zoho Books returned an invalid invoice balance');
      return { balanceMinor: invoice.balanceMinor, currency: invoice.currency, totalMinor: invoice.amountMinor, externalId: invoice.externalId };
    },
    async fetchInvoice({ token, accountId, invoiceId }) {
      if (!accountId || !invoiceId) throw new Error('Zoho Books organization and invoice IDs are required');
      const url = new URL(`${token.apiDomain || ZOHO_DEFAULT_API}/books/v3/invoices/${encodeURIComponent(invoiceId)}`);
      url.search = new URLSearchParams({ organization_id: accountId }).toString();
      const body = await jsonResponse(await providerFetch(fetchImpl, 'zoho_books', url, { headers: { Authorization: `Zoho-oauthtoken ${token.accessToken}`, Accept: 'application/json' } }), 'zoho_books');
      const invoice = normalizeZohoInvoice(body.invoice);
      if (!invoice || invoice.externalId !== String(invoiceId)) throw new Error('Zoho Books returned an invalid invoice');
      return invoice;
    },
    async updateInvoice({ token, accountId, invoiceId, invoice }) {
      if (!accountId || !invoiceId || !invoice || typeof invoice !== 'object') throw new Error('Zoho Books organization, invoice ID and invoice updates are required');
      const payload = {};
      for (const [source, target] of [['dueDate', 'due_date'], ['invoiceDate', 'date'], ['invoiceNumber', 'invoice_number']]) {
        if (invoice[source] === undefined) continue;
        const value = String(invoice[source]);
        if (source !== 'invoiceNumber' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invoice dates must use YYYY-MM-DD');
        if (source === 'invoiceNumber' && (!value.trim() || value.length > 100)) throw new Error('Invoice number is invalid');
        payload[target] = value;
      }
      if (invoice.notes !== undefined) payload.notes = String(invoice.notes).slice(0, 2000);
      if (!Object.keys(payload).length) throw new Error('No supported Zoho Books invoice fields were provided');
      const url = new URL(`${token.apiDomain || ZOHO_DEFAULT_API}/books/v3/invoices/${encodeURIComponent(invoiceId)}`);
      url.search = new URLSearchParams({ organization_id: accountId }).toString();
      const response = await providerFetch(fetchImpl, 'zoho_books', url, { method: 'PUT', headers: { Authorization: `Zoho-oauthtoken ${token.accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const body = await jsonResponse(response, 'zoho_books');
      if (String(body.invoice?.invoice_id || '') !== String(invoiceId)) throw new Error('Zoho Books did not confirm the requested invoice update');
      return this.fetchInvoice({ token, accountId, invoiceId });
    },
    async createInvoice({ token, accountId, invoice }) {
      if (!accountId) throw new Error('Zoho Books organization ID is required');
      const headers = { Authorization: `Zoho-oauthtoken ${token.accessToken}`, Accept: 'application/json' };
      const existingUrl = new URL(`${token.apiDomain || ZOHO_DEFAULT_API}/books/v3/invoices`);
      existingUrl.search = new URLSearchParams({organization_id: accountId, invoice_number: invoice.invoiceNumber}).toString();
      const existingBody = await jsonResponse(await providerFetch(fetchImpl, 'zoho_books', existingUrl, {headers}), 'zoho_books');
      const existing = (existingBody.invoices || []).map(normalizeZohoInvoice).find(item => item?.number === invoice.invoiceNumber);
      if (existing) {
        const sameCustomer = String(existing.customerName || '').trim().toLowerCase() === String(invoice.clientName || '').trim().toLowerCase();
        const sameCurrency = existing.currency === String(invoice.currency || '').toUpperCase();
        const sameTotal = existing.amountMinor === amountMinor(invoice.total, invoice.currency);
        const sameDates = existing.invoiceDate === invoice.invoiceDate && existing.dueDate === invoice.dueDate;
        if (!sameCustomer || !sameCurrency || !sameTotal || !sameDates) throw new AccountingError('ACCOUNTING_INVOICE_CONFLICT', 'An existing Zoho Books invoice uses this number with different details');
        return {externalId: existing.externalId, duplicate: true};
      }

      const contactsUrl = new URL(`${token.apiDomain || ZOHO_DEFAULT_API}/books/v3/contacts`);
      contactsUrl.search = new URLSearchParams({organization_id: accountId, contact_name_contains: invoice.clientName}).toString();
      const contactsBody = await jsonResponse(await providerFetch(fetchImpl, 'zoho_books', contactsUrl, {headers}), 'zoho_books');
      let contact = (contactsBody.contacts || []).find(item => String(item.contact_name || '').toLowerCase() === invoice.clientName.toLowerCase());
      if (!contact) {
        const contactBody = {contact_name: invoice.clientName, company_name: invoice.clientName, contact_type: 'customer'};
        if (invoice.clientEmail || invoice.clientPhone) contactBody.contact_persons = [{first_name: invoice.clientName.slice(0, 100), email: invoice.clientEmail || undefined, phone: invoice.clientPhone || undefined, is_primary_contact: true}];
        const createUrl = new URL(`${token.apiDomain || ZOHO_DEFAULT_API}/books/v3/contacts`);
        createUrl.search = new URLSearchParams({organization_id: accountId}).toString();
        const created = await jsonResponse(await providerFetch(fetchImpl, 'zoho_books', createUrl, {method: 'POST', headers: {...headers, 'Content-Type': 'application/json'}, body: JSON.stringify(contactBody)}), 'zoho_books');
        contact = created.contact;
      }
      if (!contact?.contact_id) throw new Error('Zoho Books customer could not be resolved');
      const createUrl = new URL(`${token.apiDomain || ZOHO_DEFAULT_API}/books/v3/invoices`);
      createUrl.search = new URLSearchParams({organization_id: accountId}).toString();
      const payload = {customer_id: String(contact.contact_id), invoice_number: invoice.invoiceNumber, reference_number: invoice.localInvoiceId ? `cetld:${invoice.localInvoiceId}` : undefined, date: invoice.invoiceDate, due_date: invoice.dueDate, currency_code: invoice.currency, line_items: [{name: `Invoice ${invoice.invoiceNumber}`, description: invoice.notes || undefined, quantity: 1, rate: invoice.total}], notes: invoice.notes || undefined};
      const created = await jsonResponse(await providerFetch(fetchImpl, 'zoho_books', createUrl, {method: 'POST', headers: {...headers, 'Content-Type': 'application/json'}, body: JSON.stringify(payload)}), 'zoho_books');
      if (!created.invoice?.invoice_id) throw new Error('Zoho Books did not return an invoice ID');
      return {externalId: String(created.invoice.invoice_id), duplicate: false};
    },
  };
}

export function createQuickBooksProvider({ clientId = process.env.QUICKBOOKS_CLIENT_ID, clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET, redirectUri = process.env.QUICKBOOKS_REDIRECT_URI, sandbox = String(process.env.QUICKBOOKS_SANDBOX || '').toLowerCase() === 'true', fetchImpl = globalThis.fetch } = {}) {
  const apiRoot = sandbox ? 'https://sandbox-quickbooks.api.intuit.com' : 'https://quickbooks.api.intuit.com';
  const scopes = 'com.intuit.quickbooks.accounting';
  return {
    name: 'quickbooks',
    scopes,
    authorizationUrl({ state, redirectUri: callback = redirectUri } = {}) {
      if (!clientId || !callback) throw new Error('QuickBooks client is not configured');
      const url = new URL(QBO_AUTH);
      url.search = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: callback, scope: scopes, state }).toString();
      return url.toString();
    },
    async exchangeCode({ code, redirectUri: callback = redirectUri }) {
      if (!clientId || !clientSecret || !callback) throw new Error('QuickBooks client is not configured');
      const response = await providerFetch(fetchImpl, 'quickbooks', QBO_TOKEN, { method: 'POST', headers: { Authorization: basic(clientId, clientSecret), Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: formBody({ grant_type: 'authorization_code', code, redirect_uri: callback }) });
      const body = await jsonResponse(response, 'quickbooks');
      if (!body.access_token || !body.refresh_token) throw new Error('QuickBooks did not return required tokens');
      return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000 };
    },
    async refreshToken({ refreshToken }) {
      if (!clientId || !clientSecret || !refreshToken) throw new Error('QuickBooks client is not configured');
      const response = await providerFetch(fetchImpl, 'quickbooks', QBO_TOKEN, { method: 'POST', headers: { Authorization: basic(clientId, clientSecret), Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: formBody({ grant_type: 'refresh_token', refresh_token: refreshToken }) });
      const body = await jsonResponse(response, 'quickbooks');
      if (!body.access_token) throw new Error('QuickBooks did not return an access token');
      return { accessToken: body.access_token, refreshToken: body.refresh_token || refreshToken, expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000 };
    },
    async fetchInvoices({ token, accountId, page = 1 }) {
      return queryQbo(fetchImpl, token, accountId, 'Invoice', normalizeQboInvoice, apiRoot, page);
    },
    async fetchPayments({ token, accountId, page = 1 }) {
      return queryQbo(fetchImpl, token, accountId, 'Payment', normalizeQboPayment, apiRoot, page);
    },
    async fetchInvoiceBalance({ token, accountId, invoiceId }) {
      if (!accountId || !invoiceId) throw new Error('QuickBooks company and invoice IDs are required');
      const url = `${apiRoot}/v3/company/${encodeURIComponent(accountId)}/invoice/${encodeURIComponent(invoiceId)}?minorversion=75`;
      const response = await providerFetch(fetchImpl, 'quickbooks', url, { headers: { Authorization: `Bearer ${token.accessToken}`, Accept: 'application/json' } });
      const body = await jsonResponse(response, 'quickbooks');
      const invoice = normalizeQboInvoice(body.Invoice);
      if (!invoice || invoice.externalId !== String(invoiceId)) throw new Error('QuickBooks returned an invalid invoice balance');
      return { balanceMinor: invoice.balanceMinor, currency: invoice.currency, totalMinor: invoice.amountMinor, externalId: invoice.externalId };
    },
    async createInvoice({ token, accountId, invoice }) {
      if (!accountId) throw new Error('QuickBooks company ID is required');
      const headers = {Authorization: `Bearer ${token.accessToken}`, Accept: 'application/json'};
      const quote = value => String(value).replaceAll("'", "\\'");
      const query = async statement => {
        const url = `${apiRoot}/v3/company/${encodeURIComponent(accountId)}/query?query=${encodeURIComponent(statement)}&minorversion=75`;
        return jsonResponse(await providerFetch(fetchImpl, 'quickbooks', url, {headers}), 'quickbooks');
      };
      const existingBody = await query(`select * from Invoice where DocNumber = '${quote(invoice.invoiceNumber)}' MAXRESULTS 1`);
      const existing = existingBody.QueryResponse?.Invoice?.[0];
      if (existing?.Id) return {externalId: String(existing.Id), duplicate: true};
      const customerBody = await query(`select * from Customer where DisplayName = '${quote(invoice.clientName)}' MAXRESULTS 1`);
      let customer = customerBody.QueryResponse?.Customer?.[0];
      if (!customer) {
        const url = `${apiRoot}/v3/company/${encodeURIComponent(accountId)}/customer?minorversion=75`;
        const payload = {DisplayName: invoice.clientName, CompanyName: invoice.clientName};
        if (invoice.clientEmail) payload.PrimaryEmailAddr = {Address: invoice.clientEmail};
        if (invoice.clientPhone) payload.PrimaryPhone = {FreeFormNumber: invoice.clientPhone};
        const created = await jsonResponse(await providerFetch(fetchImpl, 'quickbooks', url, {method: 'POST', headers: {...headers, 'Content-Type': 'application/json'}, body: JSON.stringify(payload)}), 'quickbooks');
        customer = created.Customer;
      }
      if (!customer?.Id) throw new Error('QuickBooks customer could not be resolved');
      const url = `${apiRoot}/v3/company/${encodeURIComponent(accountId)}/invoice?minorversion=75`;
      const payload = {DocNumber: invoice.invoiceNumber, CustomerRef: {value: String(customer.Id)}, TxnDate: invoice.invoiceDate, DueDate: invoice.dueDate, CurrencyRef: {value: invoice.currency}, PrivateNote: invoice.notes || undefined, Line: [{Amount: invoice.total, DetailType: 'SalesItemLineDetail', Description: invoice.notes || `Invoice ${invoice.invoiceNumber}`, SalesItemLineDetail: {Qty: 1, UnitPrice: invoice.total}}]};
      const created = await jsonResponse(await providerFetch(fetchImpl, 'quickbooks', url, {method: 'POST', headers: {...headers, 'Content-Type': 'application/json'}, body: JSON.stringify(payload)}), 'quickbooks');
      if (!created.Invoice?.Id) throw new Error('QuickBooks did not return an invoice ID');
      return {externalId: String(created.Invoice.Id), duplicate: false};
    },
  };
}

async function queryQbo(fetchImpl, token, accountId, entity, normalize, apiRoot, page = 1) {
  if (!accountId) throw new Error('QuickBooks company ID is required');
  const query = `select * from ${entity} STARTPOSITION ${(page-1)*1000+1} MAXRESULTS 1000`;
  const url = `${apiRoot}/v3/company/${encodeURIComponent(accountId)}/query?query=${encodeURIComponent(query)}&minorversion=75`;
  const response = await providerFetch(fetchImpl, 'quickbooks', url, { headers: { Authorization: `Bearer ${token.accessToken}`, Accept: 'application/json' } });
  const body = await jsonResponse(response, 'quickbooks');
  const result = (Array.isArray(body.QueryResponse?.[entity]) ? body.QueryResponse[entity] : []).map(normalize).filter(Boolean);
  result.nextPage = result.length >= 1000 ? page+1 : null;
  return result;
}

export function createAccountingProviders(options = {}) {
  return { zoho_books: createZohoBooksProvider(options.zoho_books), quickbooks: createQuickBooksProvider(options.quickbooks) };
}
